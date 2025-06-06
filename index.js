import dotenv from 'dotenv';
dotenv.config();

import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
  PermissionFlagsBits,
  ChannelType,
  Collection,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import fetch from 'node-fetch';
import pLimit from 'p-limit';
import { joinVoiceChannel, VoiceConnectionStatus } from '@discordjs/voice';
const AbortController = globalThis.AbortController || (await import('abort-controller')).default;
import fs from 'fs';
import path from 'path';

// Configuration
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID;
const TICKET_CHANNEL_ID = process.env.TICKET_CHANNEL_ID || '1378060615721160825';
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID || '1378060614663929876';
const SUGGESTIONS_CHANNEL_ID = process.env.SUGGESTIONS_CHANNEL_ID;
const REACTION_ROLES_CHANNEL_ID = process.env.REACTION_ROLES_CHANNEL_ID;
const CHECK_INTERVAL = 60 * 1000;
const API_CONCURRENCY_LIMIT = 3;

// Reaction roles configuration
const reactionRoles = {
  '🎮': '1377336976688287765', // Gaming role ID
  '🎵': '1377337048725192885', // Music role ID
  '📢': '1377337155260776640'  // Announcements role ID
};

// Validate environment variables
const requiredEnvVars = ['TOKEN', 'CLIENT_ID', 'YOUTUBE_API_KEY', 'LOG_CHANNEL_ID'];
const missingVars = requiredEnvVars.filter(varname => !process.env[varname]);

if (missingVars.length > 0) {
  console.error('[ERROR] Missing required environment variables:', missingVars.join(', '));
  process.exit(1);
}

class Logger {
  static async sendToLogChannel(message, type = 'INFO') {
    try {
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [${type}] ${message}`;
      const truncatedMessage = logMessage.length > 1900 ? logMessage.substring(0, 1900) + '...' : logMessage;
      
      // Send to log channel if configured
      if (LOG_CHANNEL_ID) {
        const channel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
        if (channel?.isTextBased()) {
          await channel.send({
            content: `\`\`\`${truncatedMessage}\`\`\``
          });
        }
      }
      
      // Send DM to owner
      try {
        const user = await client.users.fetch('1349053338364416020').catch(() => null);
        if (user) {
          await user.send({
            content: `\`\`\`${truncatedMessage}\`\`\``
          });
        }
      } catch (dmError) {
        console.error('Failed to send log DM:', dmError);
      }
    } catch (error) {
      console.error('Failed to send log:', error);
    }
  }

  static async log(message, type = 'INFO') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${type}] ${message}`);
    await this.sendToLogChannel(message, type);
  }

  static async error(message) {
    await this.log(message, 'ERROR');
  }

  static async warn(message) {
    await this.log(message, 'WARN');
  }

  static async debug(message) {
    if (process.env.DEBUG === 'true') {
      await this.log(message, 'DEBUG');
    }
  }
}

Logger.log('Starting bot...');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates
  ],
  allowedMentions: { parse: [], repliedUser: false }
});

// Version configuration
const versionData = { 
  version: '4.0.0',
  features: [
    'YouTube Stats Tracking',
    'Moderation Tools',
    'Fun Commands',
    'Utility Commands',
    'Service Status Monitoring',
    'AFK System',
    'Ticket System',
    'Reaction Roles',
    'Suggestions System',
    'Leveling System',
    'Giveaway System',
    'Poll System',
    'Server Backup',
    'Advanced Logging'
  ]
};

Logger.log(`Running v${versionData.version}`);

// Enhanced cooldown system
class CooldownManager {
  constructor() {
    this.cooldowns = new Map();
  }

  setCooldown(userId, command, duration) {
    const key = `${userId}-${command}`;
    this.cooldowns.set(key, Date.now() + duration);
    
    setTimeout(() => this.cooldowns.delete(key), duration).unref();
  }

  getCooldown(userId, command) {
    const key = `${userId}-${command}`;
    const endTime = this.cooldowns.get(key);
    if (!endTime) return 0;
    
    const remaining = endTime - Date.now();
    return remaining > 0 ? remaining : 0;
  }
}

const cooldownManager = new CooldownManager();
const apiLimiter = pLimit(API_CONCURRENCY_LIMIT);

// AFK System
class AFKManager {
  constructor() {
    this.afkUsers = new Collection();
    this.mentionCooldown = new Set();
  }

  setAFK(userId, reason = 'AFK') {
    this.afkUsers.set(userId, {
      reason,
      timestamp: Date.now()
    });
  }

  removeAFK(userId) {
    return this.afkUsers.delete(userId);
  }

  isAFK(userId) {
    return this.afkUsers.has(userId);
  }

  getAFKData(userId) {
    return this.afkUsers.get(userId);
  }

  hasMentionCooldown(userId) {
    return this.mentionCooldown.has(userId);
  }

  setMentionCooldown(userId) {
    this.mentionCooldown.add(userId);
    setTimeout(() => this.mentionCooldown.delete(userId), 30000).unref();
  }

  updateAFKReason(userId, newReason) {
    if (this.isAFK(userId)) {
      const afkData = this.getAFKData(userId);
      afkData.reason = newReason;
      this.afkUsers.set(userId, afkData);
      return true;
    }
    return false;
  }
}

const afkManager = new AFKManager();

class LevelManager {
  constructor() {
    this.xpCooldown = new Set();
    this.dataPath = path.join(process.cwd(), 'levelData.json');
    this.userLevels = this.loadData();
  }

  loadData() {
    try {
      if (fs.existsSync(this.dataPath)) {
        const rawData = fs.readFileSync(this.dataPath, 'utf-8');
        return new Collection(JSON.parse(rawData));
      }
    } catch (error) {
      Logger.error(`Failed to load level data: ${error.message}`);
    }
    return new Collection();
  }

  saveData() {
    try {
      const data = Array.from(this.userLevels.entries());
      fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2));
    } catch (error) {
      Logger.error(`Failed to save level data: ${error.message}`);
    }
  }

  async addXP(userId, guildId) {
    if (this.xpCooldown.has(`${userId}-${guildId}`)) return;
    
    const key = `${userId}-${guildId}`;
    const userData = this.userLevels.get(key) || { xp: 0, level: 1 };
    
    userData.xp += Math.floor(Math.random() * 10) + 15;
    
    // Check level up
    const xpNeeded = this.getXPForLevel(userData.level);
    if (userData.xp >= xpNeeded) {
      userData.level += 1;
      userData.xp = 0;
      this.userLevels.set(key, userData);
      this.saveData();
      
      return { leveledUp: true, newLevel: userData.level };
    }
    
    this.userLevels.set(key, userData);
    this.saveData();
    this.xpCooldown.add(key);
    setTimeout(() => this.xpCooldown.delete(key), 60000).unref();
    
    return { leveledUp: false };
  }

  getXPForLevel(level) {
    return level * level * 50;
  }

  async getUserLevel(userId, guildId) {
    const key = `${userId}-${guildId}`;
    return this.userLevels.get(key) || { xp: 0, level: 1 };
  }
}

const levelManager = new LevelManager();

// Ticket System
class TicketManager {
  static async initializeTicketSystem() {
    try {
      const channel = await client.channels.fetch(TICKET_CHANNEL_ID);
      if (!channel) {
        Logger.error('Ticket channel not found');
        return;
      }

      // Check if message already exists
      const messages = await channel.messages.fetch({ limit: 10 });
      const existingMessage = messages.find(m => 
        m.embeds.length > 0 && 
        m.embeds[0].title === 'Support Ticket System'
      );

      if (existingMessage) return;

      const embed = new EmbedBuilder()
        .setTitle('Support Ticket System')
        .setDescription('Click the button below to create a support ticket')
        .setColor(0x5865F2);

      const button = new ButtonBuilder()
        .setCustomId('create_ticket')
        .setLabel('Create Ticket')
        .setStyle(ButtonStyle.Primary);

      const row = new ActionRowBuilder().addComponents(button);

      await channel.send({ embeds: [embed], components: [row] });
      Logger.log('Ticket system initialized');
    } catch (error) {
      Logger.error(`Failed to initialize ticket system: ${error.message}`);
    }
  }

  static async createTicket(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const guild = interaction.guild;
      const user = interaction.user;
      const category = await guild.channels.fetch(TICKET_CATEGORY_ID);

      if (!category || category.type !== ChannelType.GuildCategory) {
        throw new Error('Ticket category not found or invalid');
      }

      // Check if user already has an open ticket
      const existingChannel = guild.channels.cache.find(c => 
        c.parentId === TICKET_CATEGORY_ID && 
        c.topic === user.id
      );

      if (existingChannel) {
        return interaction.editReply({
          content: `❌ You already have an open ticket: ${existingChannel.toString()}`,
          ephemeral: true
        });
      }

      // Create ticket channel
      const ticketChannel = await guild.channels.create({
        name: `ticket-${user.username}`,
        type: ChannelType.GuildText,
        parent: TICKET_CATEGORY_ID,
        topic: user.id,
        permissionOverwrites: [
          {
            id: guild.id,
            deny: [PermissionFlagsBits.ViewChannel]
          },
          {
            id: user.id,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.AttachFiles
            ]
          },
          {
            id: '1377331407038447753', // Admin role ID
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ManageMessages,
              PermissionFlagsBits.ManageChannels
            ]
          }
        ]
      });

      const embed = new EmbedBuilder()
        .setTitle(`Ticket - ${user.username}`)
        .setDescription(`Support ticket created by ${user.toString()}\n\nPlease describe your issue here. Staff will assist you shortly.`)
        .setColor(0x5865F2)
        .setFooter({ text: `User ID: ${user.id}` })
        .setTimestamp();

      const closeButton = new ButtonBuilder()
        .setCustomId('close_ticket')
        .setLabel('Close Ticket')
        .setStyle(ButtonStyle.Danger);

      const deleteButton = new ButtonBuilder()
        .setCustomId('delete_ticket')
        .setLabel('Delete Ticket')
        .setStyle(ButtonStyle.Danger);

      const row = new ActionRowBuilder().addComponents(closeButton, deleteButton);

      await ticketChannel.send({ 
        content: `${user.toString()}, <@&1376143669345783808>`, 
        embeds: [embed], 
        components: [row] 
      });

      await interaction.editReply({
        content: `✅ Ticket created: ${ticketChannel.toString()}`,
        ephemeral: true
      });

      Logger.log(`Ticket created for ${user.tag} in ${ticketChannel.name}`);
    } catch (error) {
      Logger.error(`Failed to create ticket: ${error.message}`);
      await interaction.editReply({
        content: '❌ Failed to create ticket. Please try again later.',
        ephemeral: true
      });
    }
  }

  static async closeTicket(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const channel = interaction.channel;
      const user = interaction.user;

      if (!channel.name.startsWith('ticket-') || !channel.parentId === TICKET_CATEGORY_ID) {
        return interaction.editReply({
          content: '❌ This is not a ticket channel',
          ephemeral: true
        });
      }

      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels) && 
          !interaction.member.roles.cache.has('1376143669345783808')) {
        return interaction.editReply({
          content: '❌ You do not have permission to close this ticket',
          ephemeral: true
        });
      }

      const userId = channel.topic;
      const ticketUser = await client.users.fetch(userId).catch(() => null);

      const embed = new EmbedBuilder()
        .setTitle('Ticket Closed')
        .setDescription(`This ticket has been closed by ${user.toString()}`)
        .setColor(0xFF0000)
        .setTimestamp();

      await channel.send({ embeds: [embed] });
      await channel.edit({
        permissionOverwrites: [
          {
            id: interaction.guild.id,
            deny: [PermissionFlagsBits.ViewChannel]
          }
        ]
      });

      await interaction.editReply({
        content: '✅ Ticket closed successfully',
        ephemeral: true
      });

      Logger.log(`Ticket ${channel.name} closed by ${user.tag}`);
    } catch (error) {
      Logger.error(`Failed to close ticket: ${error.message}`);
      await interaction.editReply({
        content: '❌ Failed to close ticket. Please try again later.',
        ephemeral: true
      });
    }
  }

  static async deleteTicket(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const channel = interaction.channel;
      const user = interaction.user;

      if (!channel.name.startsWith('ticket-') || !channel.parentId === TICKET_CATEGORY_ID) {
        return interaction.editReply({
          content: '❌ This is not a ticket channel',
          ephemeral: true
        });
      }

      if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels) && 
          !interaction.member.roles.cache.has('1376143669345783808')) {
        return interaction.editReply({
          content: '❌ You do not have permission to delete this ticket',
          ephemeral: true
        });
      }

      const userId = channel.topic;
      const ticketUser = await client.users.fetch(userId).catch(() => null);

      await interaction.editReply({
        content: '✅ Ticket will be deleted in 5 seconds...',
        ephemeral: true
      });

      Logger.log(`Ticket ${channel.name} deleted by ${user.tag}`);

      // Send confirmation message before deleting
      const embed = new EmbedBuilder()
        .setTitle('Ticket Deleted')
        .setDescription(`This ticket has been deleted by ${user.toString()}`)
        .setColor(0xFF0000)
        .setTimestamp();

      await channel.send({ embeds: [embed] });
      
      // Wait 5 seconds before deleting
      setTimeout(async () => {
        try {
          await channel.delete();
        } catch (error) {
          Logger.error(`Failed to delete ticket channel: ${error.message}`);
        }
      }, 5000);

    } catch (error) {
      Logger.error(`Failed to delete ticket: ${error.message}`);
      await interaction.editReply({
        content: '❌ Failed to delete ticket. Please try again later.',
        ephemeral: true
      });
    }
  }
}

// Suggestion System
class SuggestionManager {
  static async handleSuggestion(interaction) {
    const modal = new ModalBuilder()
      .setCustomId('suggestionModal')
      .setTitle('Submit a Suggestion');

    const suggestionInput = new TextInputBuilder()
      .setCustomId('suggestionInput')
      .setLabel('What would you like to suggest?')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1000);

    const actionRow = new ActionRowBuilder().addComponents(suggestionInput);
    modal.addComponents(actionRow);

    await interaction.showModal(modal);
  }

  static async processSuggestion(interaction) {
    await interaction.deferReply({ ephemeral: true });
    
    const suggestion = interaction.fields.getTextInputValue('suggestionInput');
    const user = interaction.user;
    
    try {
      const channel = await client.channels.fetch(SUGGESTIONS_CHANNEL_ID);
      if (!channel) {
        throw new Error('Suggestions channel not found');
      }
      
      const embed = new EmbedBuilder()
        .setTitle('New Suggestion')
        .setDescription(suggestion)
        .setColor(0x5865F2)
        .setAuthor({
          name: user.tag,
          iconURL: user.displayAvatarURL()
        })
        .setFooter({ text: `User ID: ${user.id}` })
        .setTimestamp();
      
      const message = await channel.send({ embeds: [embed] });
      await message.react('👍');
      await message.react('👎');
      
      await interaction.editReply({
        content: '✅ Your suggestion has been submitted!',
        ephemeral: true
      });
      
      Logger.log(`Suggestion submitted by ${user.tag}`);
    } catch (error) {
      Logger.error(`Failed to process suggestion: ${error.message}`);
      await interaction.editReply({
        content: '❌ Failed to submit your suggestion. Please try again later.',
        ephemeral: true
      });
    }
  }
}

// Reaction Role System
class ReactionRoleManager {
  static async initializeReactionRoles() {
    if (!REACTION_ROLES_CHANNEL_ID) return;
    
    try {
      const channel = await client.channels.fetch(REACTION_ROLES_CHANNEL_ID);
      if (!channel) {
        Logger.error('Reaction roles channel not found');
        return;
      }
      
      // Check if message already exists
      const messages = await channel.messages.fetch({ limit: 10 });
      const existingMessage = messages.find(m => 
        m.embeds.length > 0 && 
        m.embeds[0].title === 'Reaction Roles'
      );
      
      if (existingMessage) return;
      
      const embed = new EmbedBuilder()
        .setTitle('Reaction Roles')
        .setDescription('React to this message to get roles!\n\n' +
          '🎮 - Gaming\n' +
          '🎵 - Music\n' +
          '📢 - Announcements')
        .setColor(0x5865F2);
      
      const message = await channel.send({ embeds: [embed] });
      
      // Add reactions
      for (const emoji of Object.keys(reactionRoles)) {
        await message.react(emoji);
      }
      
      Logger.log('Reaction roles initialized');
    } catch (error) {
      Logger.error(`Failed to initialize reaction roles: ${error.message}`);
    }
  }
  
  static async handleReactionAdd(reaction, user) {
    if (user.bot) return;
    if (!REACTION_ROLES_CHANNEL_ID) return;
    if (reaction.message.channelId !== REACTION_ROLES_CHANNEL_ID) return;
    
    try {
      const emoji = reaction.emoji.name;
      const roleId = reactionRoles[emoji];
      
      if (!roleId) return;
      
      const member = await reaction.message.guild.members.fetch(user.id);
      if (!member) return;
      
      await member.roles.add(roleId);
      Logger.log(`Added role ${roleId} to ${user.tag} for reacting with ${emoji}`);
    } catch (error) {
      Logger.error(`Failed to add reaction role: ${error.message}`);
    }
  }
  
  static async handleReactionRemove(reaction, user) {
    if (user.bot) return;
    if (!REACTION_ROLES_CHANNEL_ID) return;
    if (reaction.message.channelId !== REACTION_ROLES_CHANNEL_ID) return;
    
    try {
      const emoji = reaction.emoji.name;
      const roleId = reactionRoles[emoji];
      
      if (!roleId) return;
      
      const member = await reaction.message.guild.members.fetch(user.id);
      if (!member) return;
      
      await member.roles.remove(roleId);
      Logger.log(`Removed role ${roleId} from ${user.tag} for removing reaction ${emoji}`);
    } catch (error) {
      Logger.error(`Failed to remove reaction role: ${error.message}`);
    }
  }
}

// API Services
class YouTubeService {
  static async getChannelInfo(channelName) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const url = new URL('https://www.googleapis.com/youtube/v3/search');
      url.searchParams.append('part', 'snippet');
      url.searchParams.append('q', channelName);
      url.searchParams.append('type', 'channel');
      url.searchParams.append('key', YOUTUBE_API_KEY);
      url.searchParams.append('maxResults', '1');

      const response = await apiLimiter(() => fetch(url, { signal: controller.signal }));
      clearTimeout(timeout);
      
      if (!response.ok) {
        throw new Error(`YouTube API: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (!data.items || data.items.length === 0) {
        return { channelId: null, channelTitle: null };
      }

      return {
        channelId: data.items[0].id.channelId,
        channelTitle: data.items[0].snippet.title,
        thumbnail: data.items[0].snippet.thumbnails?.high?.url
      };
    } catch (error) {
      Logger.error(`YouTubeService: ${error.message}`);
      return { channelId: null, channelTitle: null };
    }
  }

  static async getSubscribers(channelId) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      
      const response = await apiLimiter(() => fetch(
        `https://backend.mixerno.space/api/youtube/estv3/${channelId}`,
        { signal: controller.signal }
      ));
      clearTimeout(timeout);
      
      if (!response.ok) {
        throw new Error(`Mixerno API: ${response.status} ${response.statusText}`);
      }
      
      const data = await response.json();
      
      if (!data || !data.items || !data.items[0] || typeof data.items[0].statistics?.subscriberCount !== 'number') {
        throw new Error('Invalid API response structure');
      }
      
      return data.items[0].statistics.subscriberCount;
    } catch (error) {
      Logger.error(`MixernoService: ${error.message}`);
      return null;
    }
  }
}

// Status Monitoring Service
class StatusService {
  static async checkUrl(url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      const res = await apiLimiter(() => fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      }));
      clearTimeout(timeout);
      
      Logger.debug(`${url} status: ${res.status}`);
      return res.ok;
    } catch (e) {
      Logger.error(`${url} error: ${e.message}`);
      return false;
    }
  }

  static async getStatuses() {
    const results = await Promise.all(services.map(async service => {
      if (service.fixedStatus) {
        return { name: service.name, status: service.fixedStatus };
      }
      if (service.url) {
        const ok = await this.checkUrl(service.url);
        return { name: service.name, status: ok ? 'Up' : 'Down' };
      }
      return { name: service.name, status: 'Unknown' };
    }));

    return results;
  }

  static createStatusEmbed(statuses) {
    const embed = new EmbedBuilder()
      .setTitle('🚦 Service Status')
      .setColor('#FFA500')
      .setTimestamp()
      .setFooter({ text: `v${versionData.version}`, iconURL: client.user.displayAvatarURL() });

    const upServices = statuses.filter(s => s.status === 'Up');
    const downServices = statuses.filter(s => s.status === 'Down');

    if (upServices.length) {
      embed.addFields({
        name: '✅ Operational',
        value: upServices.map(s => `**${s.name}**`).join('\n'),
        inline: true,
      });
    }

    if (downServices.length) {
      embed.addFields({
        name: '❌ Down',
        value: downServices.map(s => `**${s.name}**`).join('\n'),
        inline: true,
      });
    }

    embed.addFields({
      name: '⏱ Last Checked',
      value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
      inline: false,
    });

    return embed;
  }
}

// Status Monitor
class StatusMonitor {
  constructor() {
    this.statusMessageId = null;
    this.cachedStatuses = null;
    this.lastCheck = 0;
  }

  async initialize() {
    if (!STATUS_CHANNEL_ID) {
      Logger.warn('Error: STATUS_CHANNEL_ID is not set in environment variables');
      return;
    }

    try {
      const channel = await client.channels.fetch(STATUS_CHANNEL_ID);
      if (!channel) {
        Logger.error('Status channel not found');
        return;
      }

      await this.updateStatusMessage(channel);
      setInterval(() => this.updateStatusMessage(channel), CHECK_INTERVAL);
      Logger.log('Status monitoring initialized');
    } catch (error) {
      Logger.error(`Status monitor initialization failed: ${error.message}`);
    }
  }

  async updateStatusMessage(channel) {
    try {
      if (this.cachedStatuses && Date.now() - this.lastCheck < 30000) {
        const embed = StatusService.createStatusEmbed(this.cachedStatuses);
        await this.updateOrCreateMessage(channel, embed);
        return;
      }

      const statuses = await StatusService.getStatuses();
      this.cachedStatuses = statuses;
      this.lastCheck = Date.now();

      const embed = StatusService.createStatusEmbed(statuses);
      await this.updateOrCreateMessage(channel, embed);
    } catch (error) {
      Logger.error(`Status update failed: ${error.message}`);
    }
  }

  async updateOrCreateMessage(channel, embed) {
    try {
      if (this.statusMessageId) {
        const msg = await channel.messages.fetch(this.statusMessageId).catch(() => null);
        if (msg) {
          await msg.edit({ embeds: [embed] });
          return;
        }
      }
      
      const newMsg = await channel.send({ embeds: [embed] });
      this.statusMessageId = newMsg.id;
    } catch (error) {
      Logger.error(`Failed to update status message: ${error.message}`);
    }
  }
}

const statusMonitor = new StatusMonitor();

async function connectToVoiceChannel() {
  try {
    const channelId = '1378060602160709654';
    const channel = await client.channels.fetch(channelId);
    
    if (!channel || channel.type !== ChannelType.GuildVoice) {
      Logger.error('Voice channel not found or invalid');
      return;
    }
    
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfMute: true
    });
    
    Logger.log(`Connected to voice channel ${channel.name} and muted`);
    
    connection.on('error', error => {
      Logger.error(`Voice connection error: ${error.message}`);
    });
    
    connection.on('stateChange', (oldState, newState) => {
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        Logger.log('Disconnected from voice channel - attempting to reconnect...');
        setTimeout(connectToVoiceChannel, 20000);
      }
    });
    
  } catch (error) {
    Logger.error(`Failed to connect to voice channel: ${error.message}`);
    setTimeout(connectToVoiceChannel, 20000);
  }
}

// New: Giveaway System
class GiveawayManager {
  constructor() {
    this.giveaways = new Map();
    this.dataPath = path.join(process.cwd(), 'giveaways.json');
    this.loadGiveaways();
  }

  loadGiveaways() {
    try {
      if (fs.existsSync(this.dataPath)) {
        const data = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
        for (const [id, giveaway] of Object.entries(data)) {
          this.giveaways.set(id, {
            ...giveaway,
            participants: new Set(giveaway.participants),
            endTime: new Date(giveaway.endTime).getTime()
          });
        }
        Logger.log(`Loaded ${this.giveaways.size} giveaways from file`);
      }
    } catch (error) {
      Logger.error(`Failed to load giveaways: ${error.message}`);
    }
  }

  saveGiveaways() {
    try {
      const data = {};
      this.giveaways.forEach((giveaway, id) => {
        data[id] = {
          ...giveaway,
          participants: Array.from(giveaway.participants)
        };
      });
      fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2));
    } catch (error) {
      Logger.error(`Failed to save giveaways: ${error.message}`);
    }
  }

  parseDuration(durationStr) {
    const regex = /(\d+)([dhm])/;
    const matches = durationStr.match(regex);
    if (!matches) return 0;

    const value = parseInt(matches[1]);
    const unit = matches[2];

    switch (unit) {
      case 'd': return value * 24 * 60 * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'm': return value * 60 * 1000;
      default: return 0;
    }
  }

  formatDuration(ms) {
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));
    
    let result = [];
    if (days > 0) result.push(`${days} day${days > 1 ? 's' : ''}`);
    if (hours > 0) result.push(`${hours} hour${hours > 1 ? 's' : ''}`);
    if (minutes > 0) result.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
    
    return result.join(' ') || '0 minutes';
  }

  async startGiveaway(interaction, duration, winners, prize) {
    await interaction.deferReply({ ephemeral: true });

    const durationMs = this.parseDuration(duration);
    if (durationMs <= 0) {
      return interaction.editReply({
        content: '❌ Invalid duration. Format: 1d, 2h, 30m or combination',
        ephemeral: true
      });
    }

    const endTime = Date.now() + durationMs;
    const giveawayId = `${interaction.channelId}-${Date.now()}`;

    const embed = new EmbedBuilder()
      .setTitle(`🎉 Giveaway: ${prize}`)
      .setDescription(`React with 🎉 to participate!\n\n**Duration:** ${this.formatDuration(durationMs)}\n**Winners:** ${winners}\n**Hosted by:** ${interaction.user}`)
      .setColor(0xFFD700)
      .setFooter({ text: `Ends at` })
      .setTimestamp(endTime);

    const message = await interaction.channel.send({ embeds: [embed] });
    await message.react('🎉');

    this.giveaways.set(giveawayId, {
      messageId: message.id,
      channelId: interaction.channelId,
      endTime,
      winners,
      prize,
      participants: new Set(),
      creator: interaction.user.id
    });

    this.saveGiveaways();

    setTimeout(() => this.endGiveaway(giveawayId), durationMs);

    await interaction.editReply({
      content: `✅ Giveaway started in ${interaction.channel.toString()}`,
      ephemeral: true
    });

    Logger.log(`Giveaway started by ${interaction.user.tag} in ${interaction.guild.name}`);
  }

  async endGiveaway(giveawayId) {
    const giveaway = this.giveaways.get(giveawayId);
    if (!giveaway) return;

    try {
      const channel = await client.channels.fetch(giveaway.channelId);
      if (!channel) {
        Logger.error(`Giveaway channel not found: ${giveaway.channelId}`);
        return;
      }

      const message = await channel.messages.fetch(giveaway.messageId);
      if (!message) {
        Logger.error(`Giveaway message not found: ${giveaway.messageId}`);
        return;
      }

      const reaction = message.reactions.cache.get('🎉');
      if (!reaction) {
        await channel.send(`🎉 Giveaway for **${giveaway.prize}** ended with no participants!`);
        this.giveaways.delete(giveawayId);
        this.saveGiveaways();
        return;
      }

      const users = await reaction.users.fetch();
      const participants = users.filter(u => !u.bot).map(u => u.id);
      
      if (participants.length === 0) {
        await channel.send(`🎉 Giveaway for **${giveaway.prize}** ended with no participants!`);
        this.giveaways.delete(giveawayId);
        this.saveGiveaways();
        return;
      }

      const winners = [];
      const winnerCount = Math.min(giveaway.winners, participants.length);
      
      for (let i = 0; i < winnerCount; i++) {
        const randomIndex = Math.floor(Math.random() * participants.length);
        winners.push(participants[randomIndex]);
        participants.splice(randomIndex, 1);
      }

      const winnerMentions = winners.map(id => `<@${id}>`).join(', ');
      const embed = new EmbedBuilder()
        .setTitle(`🎉 Giveaway Ended: ${giveaway.prize}`)
        .setDescription(`**Winner(s):** ${winnerMentions}\n**Participants:** ${users.size - 1}\n**Hosted by:** <@${giveaway.creator}>`)
        .setColor(0xFFD700)
        .setFooter({ text: 'Congratulations!' })
        .setTimestamp();

      await channel.send({
        content: `Congratulations ${winnerMentions}! You won **${giveaway.prize}**!`,
        embeds: [embed]
      });

      this.giveaways.delete(giveawayId);
      this.saveGiveaways();
      Logger.log(`Giveaway for ${giveaway.prize} ended with ${winners.length} winners`);
    } catch (error) {
      Logger.error(`Error ending giveaway: ${error.message}`);
    }
  }

  async rerollGiveaway(interaction, messageId) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const giveaway = Array.from(this.giveaways.values()).find(g => g.messageId === messageId);
      if (!giveaway) {
        return interaction.editReply({
          content: '❌ No active giveaway found with that message ID',
          ephemeral: true
        });
      }

      const channel = await client.channels.fetch(giveaway.channelId);
      const message = await channel.messages.fetch(messageId);
      const reaction = message.reactions.cache.get('🎉');

      if (!reaction) {
        return interaction.editReply({
          content: '❌ No participants found for this giveaway',
          ephemeral: true
        });
      }

      const users = await reaction.users.fetch();
      const participants = users.filter(u => !u.bot).map(u => u.id);
      
      if (participants.length === 0) {
        return interaction.editReply({
          content: '❌ No valid participants found',
          ephemeral: true
        });
      }
        
      const winnerCount = Math.min(giveaway.winners, participants.length);
      const winners = [];
      
      for (let i = 0; i < winnerCount; i++) {
        const randomIndex = Math.floor(Math.random() * participants.length);
        winners.push(participants[randomIndex]);
        participants.splice(randomIndex, 1);
      }

      const winnerMentions = winners.map(id => `<@${id}>`).join(', ');
      
      await interaction.editReply({
        content: `✅ New winner(s) selected: ${winnerMentions}`,
        ephemeral: true
      });

      await channel.send({
        content: `🎉 New winner(s) selected for the giveaway of **${giveaway.prize}**: ${winnerMentions}!`
      });

      Logger.log(`Giveaway rerolled by ${interaction.user.tag} with new winners: ${winnerMentions}`);
    } catch (error) {
      Logger.error(`Error rerolling giveaway: ${error.message}`);
      await interaction.editReply({
        content: '❌ Failed to reroll giveaway',
        ephemeral: true
      });
    }
  }
}

const giveawayManager = new GiveawayManager();

// New: Poll System
class PollManager {
  static async createPoll(interaction, question, options, duration) {
    await interaction.deferReply({ ephemeral: true });

    const durationMs = this.parseDuration(duration);
    if (durationMs <= 0) {
      return interaction.editReply({
        content: '❌ Invalid duration. Format: 1d, 2h, 30m or combination',
        ephemeral: true
      });
    }

    const endTime = Date.now() + durationMs;
    const optionEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
    const pollOptions = options.split('|').map((opt, i) => `${optionEmojis[i]} ${opt.trim()}`).join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`📊 Poll: ${question}`)
      .setDescription(pollOptions)
      .setColor(0x5865F2)
      .setFooter({ text: `Poll ends at` })
      .setTimestamp(endTime);

    const message = await interaction.channel.send({ embeds: [embed] });
    
    // Add reactions for each option
    const optionCount = Math.min(options.split('|').length, optionEmojis.length);
    for (let i = 0; i < optionCount; i++) {
      await message.react(optionEmojis[i]);
    }

    await interaction.editReply({
      content: `✅ Poll created in ${interaction.channel.toString()}`,
      ephemeral: true
    });

    Logger.log(`Poll created by ${interaction.user.tag} in ${interaction.guild.name}`);

    // Schedule poll ending
    setTimeout(async () => {
      try {
        const endedMessage = await message.fetch();
        const reactions = endedMessage.reactions.cache;
        
        let results = [];
        for (let i = 0; i < optionCount; i++) {
          const reaction = reactions.get(optionEmojis[i]);
          results.push({
            option: options.split('|')[i].trim(),
            votes: reaction ? reaction.count - 1 : 0,
            emoji: optionEmojis[i]
          });
        }

        results.sort((a, b) => b.votes - a.votes);

        const resultDescription = results.map(r => 
          `${r.emoji} **${r.option}**: ${r.votes} vote${r.votes !== 1 ? 's' : ''}`
        ).join('\n');

        const resultEmbed = new EmbedBuilder()
          .setTitle(`📊 Poll Results: ${question}`)
          .setDescription(resultDescription)
          .setColor(0x5865F2)
          .setFooter({ text: 'Poll ended' })
          .setTimestamp();

        await interaction.channel.send({ embeds: [resultEmbed] });
      } catch (error) {
        Logger.error(`Error ending poll: ${error.message}`);
      }
    }, durationMs);
  }

  static parseDuration(durationStr) {
    const regex = /(\d+)([dhm])/;
    const matches = durationStr.match(regex);
    if (!matches) return 0;

    const value = parseInt(matches[1]);
    const unit = matches[2];

    switch (unit) {
      case 'd': return value * 24 * 60 * 60 * 1000;
      case 'h': return value * 60 * 60 * 1000;
      case 'm': return value * 60 * 1000;
      default: return 0;
    }
  }
}

// New: Server Backup System
class BackupManager {
  static async createBackup(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const guild = interaction.guild;
      const backupData = {
        metadata: {
          name: guild.name,
          id: guild.id,
          created: new Date().toISOString(),
          owner: guild.ownerId,
          memberCount: guild.memberCount
        },
        roles: guild.roles.cache.map(role => ({
          id: role.id,
          name: role.name,
          color: role.color,
          position: role.position,
          permissions: role.permissions.bitfield.toString(),
          mentionable: role.mentionable,
          hoist: role.hoist
        })),
        channels: guild.channels.cache.map(channel => ({
          id: channel.id,
          name: channel.name,
          type: channel.type,
          position: channel.position,
          parentId: channel.parentId,
          topic: channel.topic,
          nsfw: channel.nsfw,
          rateLimit: channel.rateLimitPerUser,
          permissionOverwrites: channel.permissionOverwrites.cache.map(overwrite => ({
            id: overwrite.id,
            type: overwrite.type,
            allow: overwrite.allow.bitfield.toString(),
            deny: overwrite.deny.bitfield.toString()
          }))
        })),
        emojis: guild.emojis.cache.map(emoji => ({
          name: emoji.name,
          id: emoji.id,
          animated: emoji.animated,
          url: emoji.url
        }))
      };

      const backupJson = JSON.stringify(backupData, null, 2);
      const backupFile = Buffer.from(backupJson);

      await interaction.editReply({
        content: '✅ Server backup created successfully!',
        files: [{
          attachment: backupFile,
          name: `${guild.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}_backup_${new Date().toISOString().split('T')[0]}.json`
        }],
        ephemeral: true
      });

      Logger.log(`Server backup created by ${interaction.user.tag} for ${guild.name}`);
    } catch (error) {
      Logger.error(`Error creating server backup: ${error.message}`);
      await interaction.editReply({
        content: '❌ Failed to create server backup',
        ephemeral: true
      });
    }
  }
}

// Command Registry
class CommandManager {
  static getCommands() {
    return [
      // YouTube Stats Command
      new SlashCommandBuilder()
        .setName('youtube')
        .setDescription('Get YouTube channel statistics')
        .addStringOption(option =>
          option.setName('channel')
            .setDescription('YouTube channel name or ID')
            .setRequired(true))
        .addBooleanOption(option =>
          option.setName('private')
            .setDescription('Show results only to you')
            .setRequired(false)),
        
      new SlashCommandBuilder()
        .setName('warnings')
        .setDescription('Check a user\'s warnings (Mod only)')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('User to check')
            .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),

      new SlashCommandBuilder()
        .setName('broadcast')
        .setDescription('Broadcast a message to all text channels (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

      // Moderation Commands
      new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a user from the server')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('The user to ban')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('reason')
            .setDescription('Reason for the ban')
            .setRequired(false))
        .addIntegerOption(option =>
          option.setName('days')
            .setDescription('Number of days of messages to delete')
            .setMinValue(0)
            .setMaxValue(7)
            .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
      
      new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a user from the server')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('The user to kick')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('reason')
            .setDescription('Reason for the kick')
            .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
      
      new SlashCommandBuilder()
        .setName('timeout')
        .setDescription('Timeout a user')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('The user to timeout')
            .setRequired(true))
        .addIntegerOption(option =>
          option.setName('duration')
            .setDescription('Duration in minutes')
            .setMinValue(1)
            .setMaxValue(40320)
            .setRequired(true))
        .addStringOption(option =>
          option.setName('reason')
            .setDescription('Reason for the timeout')
            .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
      
      // Fun Commands
      new SlashCommandBuilder()
        .setName('joke')
        .setDescription('Get a random joke')
        .addStringOption(option =>
          option.setName('category')
            .setDescription('Joke category')
            .addChoices(
              { name: 'Programming', value: 'programming' },
              { name: 'Pun', value: 'pun' },
              { name: 'Dark', value: 'dark' }
            )
            .setRequired(false)),
      
      new SlashCommandBuilder()
        .setName('meme')
        .setDescription('Get a random meme from Reddit')
        .addStringOption(option =>
          option.setName('subreddit')
            .setDescription('Subreddit to get memes from')
            .setRequired(false)),
      
      // Utility Commands
      new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check bot latency and status'),
      
      new SlashCommandBuilder()
        .setName('avatar')
        .setDescription("Get a user's avatar")
        .addUserOption(option =>
          option.setName('user')
            .setDescription('The user whose avatar you want')
            .setRequired(false)),
      
      new SlashCommandBuilder()
        .setName('serverinfo')
        .setDescription('Get information about this server'),
      
      new SlashCommandBuilder()
        .setName('userinfo')
        .setDescription('Get information about a user')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('The user to get info about')
            .setRequired(false)),
      
      // Admin Commands
      new SlashCommandBuilder()
        .setName('say')
        .setDescription('Make the bot say something (Admin only)')
        .addStringOption(option =>
          option.setName('message')
            .setDescription('What the bot should say')
            .setRequired(true))
        .addChannelOption(option =>
          option.setName('channel')
            .setDescription('Channel to send the message to')
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
      
      new SlashCommandBuilder()
        .setName('botinfo')
        .setDescription('Get information about this bot'),
      
      // Status Command
      new SlashCommandBuilder()
        .setName('status')
        .setDescription('Check the status of various services')
        .addBooleanOption(option =>
          option.setName('private')
            .setDescription('Show results only to you')
            .setRequired(false)),

      // AFK Commands
      new SlashCommandBuilder()
        .setName('afk')
        .setDescription('Set your AFK status')
        .addStringOption(option =>
          option.setName('reason')
            .setDescription('Reason for being AFK')
            .setRequired(false)),

      new SlashCommandBuilder()
        .setName('unafk')
        .setDescription('Remove your AFK status'),

      new SlashCommandBuilder()
        .setName('changeafkreason')
        .setDescription('Change your AFK reason without losing your AFK status')
        .addStringOption(option =>
          option.setName('reason')
            .setDescription('New AFK reason')
            .setRequired(true)),

      // Help Command
      new SlashCommandBuilder()
        .setName('help')
        .setDescription('Show list of available commands')
        .addStringOption(option =>
          option.setName('command')
            .setDescription('Command name to get specific details')
            .setRequired(false)
            .setAutocomplete(true)),

      // Ticket Command
      new SlashCommandBuilder()
        .setName('ticket')
        .setDescription('Manage the ticket system (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
        .addSubcommand(subcommand =>
          subcommand
            .setName('setup')
            .setDescription('Initialize the ticket system'))
        .addSubcommand(subcommand =>
          subcommand
            .setName('close')
            .setDescription('Close the current ticket')),

      // Suggestion Command
      new SlashCommandBuilder()
        .setName('suggest')
        .setDescription('Submit a suggestion for the server'),

      // Level Command
      new SlashCommandBuilder()
        .setName('level')
        .setDescription('Check your current level and XP')
        .addUserOption(option =>
          option.setName('user')
            .setDescription('The user to check (defaults to you)')
            .setRequired(false)),

      new SlashCommandBuilder()
        .setName('invite')
        .setDescription('Send server invite links to owner (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
        
      new SlashCommandBuilder()
        .setName('leaderboard')
        .setDescription('Show the top 10 users with the highest level in this server'),

      // Set Status Command
      new SlashCommandBuilder()
        .setName('setstatus')
        .setDescription('Change the bot status (Admin only)')
        .addStringOption(option =>
          option.setName('status')
            .setDescription('New bot status')
            .setRequired(true)
            .addChoices(
              { name: 'Online', value: 'online' },
              { name: 'Do Not Disturb', value: 'dnd' },
              { name: 'Idle', value: 'idle' },
              { name: 'Invisible', value: 'invisible' }
            )
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

      // New: Giveaway Commands
      new SlashCommandBuilder()
        .setName('giveaway')
        .setDescription('Manage giveaways')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addSubcommand(subcommand =>
          subcommand
            .setName('start')
            .setDescription('Start a new giveaway')
            .addStringOption(option =>
              option.setName('duration')
                .setDescription('Giveaway duration (e.g. 1d, 2h, 30m)')
                .setRequired(true))
            .addIntegerOption(option =>
              option.setName('winners')
                .setDescription('Number of winners')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(10))
            .addStringOption(option =>
              option.setName('prize')
                .setDescription('Prize for the giveaway')
                .setRequired(true)))
        .addSubcommand(subcommand =>
          subcommand
            .setName('reroll')
            .setDescription('Reroll a giveaway')
            .addStringOption(option =>
              option.setName('message_id')
                .setDescription('Message ID of the giveaway to reroll')
                .setRequired(true))),

      // New: Poll Command
      new SlashCommandBuilder()
        .setName('poll')
        .setDescription('Create a poll')
        .addStringOption(option =>
          option.setName('question')
            .setDescription('Poll question')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('options')
            .setDescription('Poll options separated by | (max 10)')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('duration')
            .setDescription('Poll duration (e.g. 1d, 2h, 30m)')
            .setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

      // New: Backup Command
      new SlashCommandBuilder()
        .setName('backup')
        .setDescription('Create a server backup (Admin only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    ].map(command => command.toJSON());
  }

  static async registerCommands() {
    try {
      const rest = new REST({ version: '10' }).setToken(TOKEN);
      Logger.log('Registering slash commands...');
      
      await rest.put(
        Routes.applicationCommands(CLIENT_ID), 
        { body: this.getCommands() }
      );
      
      Logger.log('Successfully registered commands!');
    } catch (error) {
      Logger.error(`Command registration failed: ${error.message}`);
      throw error;
    }
  }
}

// Command Handlers
class CommandHandlers {
  static async handleYouTubeCommand(interaction) {
    if (client.ws.ping > 300) {
      return interaction.reply({
        content: '⚠ Bot is currently busy. Please try again later.',
        ephemeral: true
      });
    }

    const channelQuery = interaction.options.getString('channel');
    const ephemeral = interaction.options.getBoolean('private') || false;
    
    await interaction.deferReply({ ephemeral });
    
    const cooldown = cooldownManager.getCooldown(interaction.user.id, 'youtube');
    if (cooldown > 0) {
      return interaction.editReply({
        content: `⏳ Please wait ${Math.ceil(cooldown/1000)} seconds before using this command again.`,
        ephemeral: true
      });
    }
    
    cooldownManager.setCooldown(interaction.user.id, 'youtube', 5000);
    
    const { channelId, channelTitle, thumbnail } = await YouTubeService.getChannelInfo(channelQuery);
    if (!channelId) {
      return interaction.editReply({ 
        content: '❌ Channel not found. Please try a different name or ID.',
        ephemeral
      });
    }

    const subscriberCount = await YouTubeService.getSubscribers(channelId);
    if (subscriberCount === null) {
      return interaction.editReply({ 
        content: '❌ Failed to get subscriber count. Please try again later.',
        ephemeral
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(channelTitle)
      .setDescription(`📊 **Subscribers:** ${subscriberCount.toLocaleString()}`)
      .setColor('#FF0000')
      .setThumbnail(thumbnail || null)
      .setFooter({ 
        text: `Requested by ${interaction.user.username} | v${versionData.version}`,
        iconURL: interaction.user.displayAvatarURL()
      })
      .setTimestamp();

    const refreshButton = new ButtonBuilder()
      .setCustomId(`refresh-${channelId}`)
      .setLabel('🔄 Refresh')
      .setStyle(ButtonStyle.Secondary);

    await interaction.editReply({
      embeds: [embed],
      components: [new ActionRowBuilder().addComponents(refreshButton)],
      ephemeral
    });
  }

  static async handleRefreshButton(interaction) {
    const [action, channelId] = interaction.customId.split('-');
    if (action !== 'refresh') return;

    await interaction.deferUpdate();

    const cooldown = cooldownManager.getCooldown(interaction.user.id, 'refresh');
    if (cooldown > 0) {
      return interaction.followUp({
        content: `⏳ Please wait ${Math.ceil(cooldown/1000)} seconds before refreshing again.`,
        ephemeral: true
      });
    }
    
    cooldownManager.setCooldown(interaction.user.id, 'refresh', 5000);

    const count = await YouTubeService.getSubscribers(channelId);
    if (count === null) {
      return interaction.followUp({
        content: '❌ Failed to refresh subscriber count',
        ephemeral: true
      });
    }

    const newEmbed = EmbedBuilder.from(interaction.message.embeds[0])
      .setDescription(`📊 **Subscribers:** ${count.toLocaleString()}`)
      .setFooter({ 
        text: `Last updated at ${new Date().toLocaleTimeString()} | v${versionData.version}` 
      });

    await interaction.editReply({ embeds: [newEmbed] });
  }

  static async handleModerationAction(interaction, action) {
    if (!interaction.inGuild()) {
      return interaction.reply({
        content: '❌ This command can only be used in a server.',
        ephemeral: true
      });
    }

    const user = interaction.options.getUser('user');
    const reason = interaction.options.getString('reason') || 'No reason provided';
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);

    if (!member) {
      return interaction.reply({
        content: '❌ That user is not in this server.',
        ephemeral: true
      });
    }

    if (!member.manageable || !member.moderatable) {
      return interaction.reply({
        content: '❌ I cannot moderate that user due to role hierarchy.',
        ephemeral: true
      });
    }

    try {
      let actionResult;
      switch (action) {
        case 'ban':
          const days = interaction.options.getInteger('days') || 0;
          actionResult = await member.ban({ 
            reason: `${interaction.user.tag}: ${reason}`,
            deleteMessageDays: days 
          });
          break;
        
        case 'kick':
          actionResult = await member.kick(`${interaction.user.tag}: ${reason}`);
          break;
        
        case 'timeout':
          const duration = interaction.options.getInteger('duration');
          actionResult = await member.timeout(
            duration * 60 * 1000, 
            `${interaction.user.tag}: ${reason}`
          );
          break;
      }

      const embed = new EmbedBuilder()
        .setTitle(`${action.charAt(0).toUpperCase() + action.slice(1)} Successful`)
        .setDescription(`**User:** ${user.tag} (${user.id})\n**Reason:** ${reason}`)
        .setColor(action === 'ban' ? 0xFF0000 : action === 'kick' ? 0xFFA500 : 0xFFFF00)
        .setFooter({ 
          text: `Moderator: ${interaction.user.tag}`,
          iconURL: interaction.user.displayAvatarURL()
        })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });

      Logger.log(`Moderation action performed: ${action} on ${user.tag} (${user.id}) by ${interaction.user.tag}. Reason: ${reason}`);
    } catch (error) {
      Logger.error(`Moderation error (${action}): ${error.message}`);
      await interaction.reply({
        content: `❌ Failed to ${action} user: ${error.message}`,
        ephemeral: true
      });
    }
  }

  static async handleJokeCommand(interaction) {
    const category = interaction.options.getString('category');
    
    const jokes = {
      programming: [
        "Why do programmers prefer dark mode? Because light attracts bugs!",
        "Why did the programmer quit his job? He didn't get arrays!",
        "How many programmers does it take to change a light bulb? None, that's a hardware problem!"
      ],
      pun: [
        "I told my computer I needed a break... now it won't stop sending me Kit-Kats.",
        "Why don't scientists trust atoms? Because they make up everything!",
        "I'm reading a book about anti-gravity. It's impossible to put down!"
      ],
      dark: [
        "Why did the orphan bring a ladder to the bar? Because they heard the drinks were on the house!",
        "What's the difference between me and cancer? My dad didn't beat cancer!",
        "Why don't orphans play baseball? They don't know where home is!"
      ],
      default: [
        "Did you hear about the mathematician who's afraid of negative numbers? He'll stop at nothing to avoid them!",
        "Why don't skeletons fight each other? They don't have the guts!",
        "What do you call a fake noodle? An impasta!"
      ]
    };

    const selectedJokes = jokes[category] || jokes.default;
    const joke = selectedJokes[Math.floor(Math.random() * selectedJokes.length)];
    
    await interaction.reply(joke);
    Logger.log(`Joke command used by ${interaction.user.tag} in ${interaction.guild?.name || 'DM'}`);
  }

static async handleMemeCommand(interaction) {
    await interaction.deferReply();
    
    const subreddit = interaction.options.getString('subreddit') || 'memes';
    const url = `https://www.reddit.com/r/${subreddit}/random.json`;
    
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'DiscordBot/1.0 (by YourBotName)' // User-Agent personnalisé
            },
            signal: controller.signal
        });
        clearTimeout(timeout);

        if (!response.ok) {
            if (response.status === 403) {
                return interaction.editReply({
                    content: '❌ Reddit a bloqué la requête. Essayez plus tard ou utilisez une autre source de memes.'
                });
            }
            throw new Error(`Reddit API: ${response.status}`);
        }
        
        const [data] = await response.json();
        if (!data?.data?.children?.length) {
            throw new Error('No posts found');
        }
        
        const post = data.data.children[0].data;
        if (post.over_18 && !interaction.channel.nsfw) {
            return interaction.editReply({
                content: '🔞 Ce meme est NSFW et ne peut être posté que dans les channels NSFW.'
            });
        }
        
        const embed = new EmbedBuilder()
            .setTitle(post.title)
            .setURL(`https://reddit.com${post.permalink}`)
            .setImage(post.url)
            .setFooter({ text: `👍 ${post.ups} | r/${subreddit}` })
            .setColor(0xFF4500);
        
        await interaction.editReply({ embeds: [embed] });
        Logger.log(`Meme from r/${subreddit} posted by ${interaction.user.tag}`);
    } catch (error) {
        Logger.error(`Meme command error: ${error.message}`);
        await interaction.editReply({
            content: `❌ Impossible de récupérer un meme depuis r/${subreddit}. Reddit peut bloquer les requêtes automatisées. Essayez plus tard.`
        });
    }
}

  static async handlePingCommand(interaction) {
    const start = Date.now();
    const reply = await interaction.reply({ 
      content: '🏓 Pinging...', 
      fetchReply: true 
    });
    
    const latency = Date.now() - start;
    const apiLatency = Math.round(client.ws.ping);
    
    const embed = new EmbedBuilder()
      .setTitle('Bot Latency')
      .addFields(
        { name: '⌛ Response Time', value: `${latency}ms`, inline: true },
        { name: '💓 API Heartbeat', value: `${apiLatency}ms`, inline: true },
        { name: '🛠️ Status', value: latency < 200 ? '✅ Excellent' : latency < 700 ? '🟢 Good' : '🔴 Slow', inline: true }
      )
      .setColor(latency < 200 ? 0x00FF00 : latency < 700 ? 0xFFFF00 : 0xFF0000)
      .setFooter({ text: `v${versionData.version}` });
    
    await reply.edit({ 
      content: null,
      embeds: [embed] 
    });
    Logger.log(`Ping command used by ${interaction.user.tag} - Latency: ${latency}ms, API: ${apiLatency}ms`);
  }

  static async handleAvatarCommand(interaction) {
    const user = interaction.options.getUser('user') || interaction.user;
    const avatarURL = user.displayAvatarURL({ 
      size: 4096, 
      extension: 'png' 
    });
    
    const embed = new EmbedBuilder()
      .setTitle(`${user.username}'s Avatar`)
      .setImage(avatarURL)
      .setColor(user.accentColor || 0x5865F2)
      .setFooter({ 
        text: `Requested by ${interaction.user.username}`,
        iconURL: interaction.user.displayAvatarURL() 
      });
    
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel('Open in Browser')
        .setStyle(ButtonStyle.Link)
        .setURL(avatarURL)
    );
    
    await interaction.reply({ 
      embeds: [embed], 
      components: [row] 
    });
    Logger.log(`Avatar command used by ${interaction.user.tag} for ${user.tag}`);
  }

  static async handleServerInfoCommand(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({
        content: '❌ This command can only be used in a server.',
        ephemeral: true
      });
    }
    
    const guild = interaction.guild;
    const owner = await guild.fetchOwner();
    const members = await guild.members.fetch();
    const bots = members.filter(m => m.user.bot).size;
    const humans = members.size - bots;
    
    const embed = new EmbedBuilder()
      .setTitle(guild.name)
      .setThumbnail(guild.iconURL({ size: 1024 }))
      .addFields(
        { name: '👑 Owner', value: owner.user.tag, inline: true },
        { name: '🆔 Server ID', value: guild.id, inline: true },
        { name: '📅 Created', value: `<t:${Math.floor(guild.createdAt / 1000)}:D>`, inline: true },
        { name: '👥 Members', value: `${guild.memberCount} (${humans} humans, ${bots} bots)`, inline: true },
        { name: '📚 Channels', value: `${guild.channels.cache.size} total`, inline: true },
        { name: '🚀 Boost Level', value: `Level ${guild.premiumTier} (${guild.premiumSubscriptionCount} boosts)`, inline: true }
      )
      .setColor(guild.roles.highest.color || 0x5865F2)
      .setFooter({ text: `Requested by ${interaction.user.tag}` });
    
    await interaction.reply({ embeds: [embed] });
    Logger.log(`Server info command used by ${interaction.user.tag} in ${guild.name}`);
  }

  static async handleUserInfoCommand(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const member = interaction.guild?.members.resolve(targetUser);
    
    const embed = new EmbedBuilder()
      .setTitle(targetUser.tag)
      .setThumbnail(targetUser.displayAvatarURL({ size: 1024 }))
      .setColor(targetUser.accentColor || (member?.displayColor || 0x5865F2))
      .addFields(
        { name: '🆔 User ID', value: targetUser.id, inline: true },
        { name: '🤖 Bot', value: targetUser.bot ? 'Yes' : 'No', inline: true },
        { name: '📅 Account Created', value: `<t:${Math.floor(targetUser.createdAt / 1000)}:D>`, inline: true }
      );
    
    if (member) {
      embed.addFields(
        { name: '🎭 Nickname', value: member.nickname || 'None', inline: true },
        { name: '📅 Joined Server', value: `<t:${Math.floor(member.joinedAt / 1000)}:D>`, inline: true },
        { name: '🎖️ Highest Role', value: member.roles.highest.toString(), inline: true }
      );
    }
    
    await interaction.reply({ embeds: [embed] });
    Logger.log(`User info command used by ${interaction.user.tag} for ${targetUser.tag}`);
  }

  static async handleSayCommand(interaction) {
    const message = interaction.options.getString('message');
    const channel = interaction.options.getChannel('channel') || interaction.channel;

    if (containsForbiddenWords(message)) {
      await warningSystem.addWarning(interaction.user.id, `Attempted to send inappropriate message: ${message}`);

      await interaction.reply({
        content: `❌ Your message contains inappropriate content. Warning ${warningSystem.getWarnings(interaction.user.id).length}/3`,
        ephemeral: true
      });

      Logger.warn(`Blocked inappropriate say command from ${interaction.user.tag}: "${message}"`);

      const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
      if (logChannel) {
        const embed = new EmbedBuilder()
          .setTitle('⚠ Inappropriate Content Blocked')
          .setDescription(`**User:** ${interaction.user.tag} (${interaction.user.id})\n**Message:** ${message}`)
          .setColor(0xFF0000)
          .setTimestamp();

        await logChannel.send({ embeds: [embed] });
      }

      return;
    }

    try {
      await channel.send(message);
      await interaction.reply({
        content: `✅ Message sent to ${channel.toString()}`,
        ephemeral: true
      });
      Logger.log(`Say command used by ${interaction.user.tag} in ${channel.name}: "${message}"`);
    } catch (error) {
      Logger.error(`Say command error: ${error.message}`);
      await interaction.reply({
        content: `❌ Failed to send message: ${error.message}`,
        ephemeral: true
      });
    }
  }

  static async handleBotInfoCommand(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('Bot Information')
      .setThumbnail(client.user.displayAvatarURL({ size: 1024 }))
      .addFields(
        { name: '🤖 Bot Name', value: client.user.tag, inline: true },
        { name: '🆔 Bot ID', value: client.user.id, inline: true },
        { name: '📅 Created', value: `<t:${Math.floor(client.user.createdAt / 1000)}:D>`, inline: true },
        { name: '⚙️ Version', value: versionData.version, inline: true },
        { name: '📊 Servers', value: client.guilds.cache.size.toString(), inline: true },
        { name: '👥 Users', value: client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0).toString(), inline: true },
        { name: '✨ Features', value: versionData.features.join('\n') }
      )
      .setColor(0x5865F2)
      .setFooter({ text: 'Made with Discord.js' });
    
    await interaction.reply({ embeds: [embed] });
    Logger.log(`Bot info command used by ${interaction.user.tag}`);
  }

  static async handleStatusCommand(interaction) {
    const ephemeral = interaction.options.getBoolean('private') || false;
    await interaction.deferReply({ ephemeral });

    try {
      const statuses = await StatusService.getStatuses();
      const embed = StatusService.createStatusEmbed(statuses);
      
      await interaction.editReply({ embeds: [embed] });
      Logger.log(`Status command used by ${interaction.user.tag}`);
    } catch (error) {
      Logger.error(`Status command error: ${error.message}`);
      await interaction.editReply({
        content: '❌ Failed to get service statuses. Please try again later.',
        ephemeral: true
      });
    }
  }

  static async handleAFKCommand(interaction) {
    const reason = interaction.options.getString('reason') || 'AFK';
    
    afkManager.setAFK(interaction.user.id, reason);
    
    const embed = new EmbedBuilder()
      .setDescription(`✅ You are now AFK: **${reason}**`)
      .setColor(0x5865F2);
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
    Logger.log(`${interaction.user.tag} set AFK status: ${reason}`);
  }

  static async handleUNAFKCommand(interaction) {
    if (!afkManager.isAFK(interaction.user.id)) {
      return interaction.reply({ 
        content: '❌ You are not currently AFK.', 
        ephemeral: true 
      });
    }
    
    const afkData = afkManager.getAFKData(interaction.user.id);
    const duration = Math.floor((Date.now() - afkData.timestamp) / 1000);
    
    afkManager.removeAFK(interaction.user.id);
    
    const embed = new EmbedBuilder()
      .setDescription(`✅ Welcome back! You were AFK for ${duration} seconds`)
      .setColor(0x5865F2);
    
    await interaction.reply({ embeds: [embed] });
    Logger.log(`${interaction.user.tag} removed AFK status`);
  }

  static async handleChangeAFKReasonCommand(interaction) {
    if (!afkManager.isAFK(interaction.user.id)) {
      return interaction.reply({ 
        content: '❌ You are not currently AFK.', 
        ephemeral: true 
      });
    }

    const newReason = interaction.options.getString('reason');
    const afkData = afkManager.getAFKData(interaction.user.id);
    const oldReason = afkData.reason;
    
    afkManager.updateAFKReason(interaction.user.id, newReason);
    
    const embed = new EmbedBuilder()
      .setDescription(`✅ AFK reason updated\n**Old reason:** ${oldReason}\n**New reason:** ${newReason}`)
      .setColor(0x5865F2);
    
    await interaction.reply({ embeds: [embed], ephemeral: true });
    Logger.log(`${interaction.user.tag} changed AFK reason from "${oldReason}" to "${newReason}"`);
  }

  static async handleTicketCommand(interaction) {
    const subcommand = interaction.options.getSubcommand();
    
    switch (subcommand) {
      case 'setup':
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) {
          return interaction.reply({
            content: '❌ You do not have permission to set up tickets.',
            ephemeral: true
          });
        }
        
        await TicketManager.initializeTicketSystem();
        await interaction.reply({
          content: '✅ Ticket system has been initialized.',
          ephemeral: true
        });
        break;
        
      case 'close':
        await TicketManager.closeTicket(interaction);
        break;
    }
  }

  static async handleWarningsCommand(interaction) {
    const user = interaction.options.getUser('user');
    const warnings = warningSystem.getWarnings(user.id);

    if (warnings.length === 0) {
      await interaction.reply({
        content: `${user.tag} has no warnings.`,
        ephemeral: true
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`Warnings for ${user.tag}`)
      .setColor(0xFFA500)
      .setDescription(
        warnings.map((w, i) => `**${i + 1}.** <t:${Math.floor(w.timestamp / 1000)}:R> - ${w.reason}`).join('\n')
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
  }

  static async handleSuggestionCommand(interaction) {
    await SuggestionManager.handleSuggestion(interaction);
  }

  static async handleLevelCommand(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({
        content: '❌ This command can only be used in a server.',
        ephemeral: true
      });
    }

    const targetUser = interaction.options.getUser('user') || interaction.user;
    const { xp, level } = await levelManager.getUserLevel(targetUser.id, interaction.guildId);
    const xpNeeded = levelManager.getXPForLevel(level);
    
    const embed = new EmbedBuilder()
      .setTitle(`${targetUser.username}'s Level`)
      .setDescription(`**Level:** ${level}\n**XP:** ${xp}/${xpNeeded}`)
      .setColor(0x5865F2)
      .setThumbnail(targetUser.displayAvatarURL())
      .setFooter({ text: `Requested by ${interaction.user.tag}` });
    
    await interaction.reply({ embeds: [embed] });
    Logger.log(`Level command used by ${interaction.user.tag} for ${targetUser.tag}`);
  }

  static async handleHelpCommand(interaction) {
    const commandName = interaction.options.getString('command');
    const commands = CommandManager.getCommands();
    
    if (commandName) {
      const command = commands.find(cmd => cmd.name === commandName);
      if (!command) {
        return interaction.reply({
          content: `❌ Command "${commandName}" not found.`,
          ephemeral: true
        });
      }
      
      const embed = new EmbedBuilder()
        .setTitle(`Help for /${command.name}`)
        .setDescription(command.description)
        .setColor(0x5865F2);
      
      if (command.options && command.options.length > 0) {
        embed.addFields({
          name: 'Options',
          value: command.options.map(opt => {
            let desc = `• **${opt.name}**: ${opt.description}`;
            if (opt.required) desc += ' (required)';
            if (opt.choices) {
              desc += `\n  Choices: ${opt.choices.map(c => `\`${c.value}\``).join(', ')}`;
            }
            return desc;
          }).join('\n')
        });
      }
      
      await interaction.reply({ embeds: [embed], ephemeral: true });
      Logger.log(`Help command used for ${commandName} by ${interaction.user.tag}`);
    } else {
      const categories = {
        'YouTube': ['youtube'],
        'Moderation': ['ban', 'kick', 'timeout', 'warnings'],
        'Fun': ['joke', 'meme'],
        'Utilities': ['ping', 'avatar', 'serverinfo', 'userinfo', 'status', 'help', 'level', 'leaderboard'],
        'AFK': ['afk', 'unafk', 'changeafkreason'],
        'Community': ['suggest', 'poll', 'giveaway'],
        'Admin': ['say', 'botinfo', 'ticket', 'broadcast', 'invite', 'setstatus', 'backup']
      };
      
      const embed = new EmbedBuilder()
        .setTitle('📚 Bot Help')
        .setDescription(`Here's the list of available commands. Use \`/help <command>\` for more information about a specific command.\n\nVersion: v${versionData.version}`)
        .setColor(0x5865F2)
        .setFooter({ text: `Total: ${commands.length} commands` });
      
      for (const [category, cmds] of Object.entries(categories)) {
        embed.addFields({
          name: `**${category}**`,
          value: cmds.map(cmd => `• \`/${cmd}\``).join('\n'),
          inline: true
        });
      }
      
      const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('Invite Bot')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&permissions=8&scope=bot%20applications.commands`),
        new ButtonBuilder()
          .setLabel('Support Server')
          .setStyle(ButtonStyle.Link)
          .setURL('https://discord.gg/xwG6rSYD6k')
      );
      
      await interaction.reply({ 
        embeds: [embed], 
        components: [buttons],
        ephemeral: false 
      });
      Logger.log(`Help command used by ${interaction.user.tag}`);
    }
  }

  static async handleHelpAutocomplete(interaction) {
    const focusedValue = interaction.options.getFocused();
    const commands = CommandManager.getCommands();
    
    const filtered = commands.filter(command => 
      command.name.toLowerCase().includes(focusedValue.toLowerCase())
    ).slice(0, 25);
    
    await interaction.respond(
      filtered.map(command => ({ name: `/${command.name}`, value: command.name }))
    );
  }

  static async handleBroadcastCommand(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await CommandHandlers.broadcastToAllGuilds();

      if (result.success) {
        await interaction.editReply({
          content: `✅ Message broadcasted to all channels.\nSuccess: ${result.successCount}, Failures: ${result.failCount}`,
          ephemeral: true
        });
      } else {
        await interaction.editReply({
          content: `❌ Error during broadcast: ${result.error}`,
          ephemeral: true
        });
      }
    } catch (error) {
      Logger.error(`Error in handleBroadcastCommand: ${error.message}`);
      await interaction.editReply({
        content: '❌ A serious error occurred during broadcast.',
        ephemeral: true
      });
    }
  }

  static async broadcastToAllGuilds() {
    try {
      const messageContent = "Following the sending of inappropriate messages using the /say command, security measures have been put in place. Using inappropriate words more than three times will result in a ban from the server.";
      let successCount = 0;
      let failCount = 0;

      const rateLimit = pLimit(5);

      const promises = [];

      for (const guild of client.guilds.cache.values()) {
        for (const channel of guild.channels.cache.values()) {
          if (
            channel.type === ChannelType.GuildText &&
            channel.permissionsFor(guild.members.me).has(PermissionFlagsBits.SendMessages)
          ) {
            promises.push(rateLimit(async () => {
              try {
                await channel.send(messageContent);
                const logMessage = `Message sent to ${guild.name} in ${channel.name}`;
                await Logger.sendToLogChannel(logMessage);
                successCount++;
              } catch (error) {
                Logger.error(`Error sending to ${guild.name}/${channel.name}: ${error.message}`);
                failCount++;
              }
            }));
          }
        }
      }

      await Promise.all(promises);

      const summary = `Broadcast completed. Success: ${successCount}, Failures: ${failCount}`;
      await Logger.sendToLogChannel(summary);

      return { success: true, successCount, failCount };
    } catch (error) {
      Logger.error(`Global error in broadcastToAllGuilds: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  static async handleInviteCommand(interaction) {
    await interaction.deferReply({ ephemeral: true });
    try {
      await sendAllGuildInvitesToOwner();
      await interaction.editReply('✅ Server invite links have been sent to the owner in DMs.');
    } catch (error) {
      Logger.error(`Error in handleInviteCommand: ${error.message}`);
      await interaction.editReply('❌ An error occurred while sending invites.');
    }
  }

  static async handleSetStatusCommand(interaction) {
    const status = interaction.options.getString('status');
    const statusLabels = {
      online: '🟢 Online',
      dnd: '⛔ Do Not Disturb',
      idle: '🌙 Idle',
      invisible: '⚫ Invisible'
    };

    try {
      await client.user.setPresence({
        status: status
      });
      await interaction.reply({
        content: `✅ Bot status changed to: **${statusLabels[status] || status}**`,
        ephemeral: true
      });
      Logger.log(`Bot status changed to ${status} by ${interaction.user.tag}`);
    } catch (error) {
      Logger.error(`Error changing status: ${error.message}`);
      await interaction.reply({
        content: '❌ Unable to change bot status.',
        ephemeral: true
      });
    }
  }

  static async handleLeaderboardCommand(interaction) {
    if (!interaction.inGuild()) {
      return interaction.reply({
        content: '❌ This command can only be used in a server.',
        ephemeral: true
      });
    }

    const guildId = interaction.guildId;
    const leaderboard = Array.from(levelManager.userLevels.entries())
      .filter(([key, value]) => key.endsWith(`-${guildId}`))
      .map(([key, value]) => {
        const userId = key.split('-')[0];
        return { userId, ...value };
      })
      .sort((a, b) => b.level === a.level ? b.xp - a.xp : b.level - a.level)
      .slice(0, 10);

    if (leaderboard.length === 0) {
      return interaction.reply({
        content: 'No users have any levels yet in this server.',
        ephemeral: true
      });
    }

    const users = await Promise.all(
      leaderboard.map(entry => interaction.guild.members.fetch(entry.userId).catch(() => null))
    );

    const description = leaderboard.map((entry, i) => {
      const member = users[i];
      const name = member ? member.user.tag : `Unknown (${entry.userId})`;
      return `**${i + 1}.** ${name} — Level ${entry.level} (${entry.xp} XP)`;
    }).join('\n');

    const embed = new EmbedBuilder()
      .setTitle('🏆 Server Level Leaderboard')
      .setDescription(description)
      .setColor(0xFFD700)
      .setFooter({ text: `Requested by ${interaction.user.tag}` });

    await interaction.reply({ embeds: [embed] });
    Logger.log(`Leaderboard command used by ${interaction.user.tag} in ${interaction.guild.name}`);
  }

  static async handleGiveawayCommand(interaction) {
    const subcommand = interaction.options.getSubcommand();
    
    switch (subcommand) {
      case 'start':
        const duration = interaction.options.getString('duration');
        const winners = interaction.options.getInteger('winners');
        const prize = interaction.options.getString('prize');
        
        await giveawayManager.startGiveaway(interaction, duration, winners, prize);
        break;
        
      case 'reroll':
        const messageId = interaction.options.getString('message_id');
        await giveawayManager.rerollGiveaway(interaction, messageId);
        break;
    }
  }

  static async handlePollCommand(interaction) {
    const question = interaction.options.getString('question');
    const options = interaction.options.getString('options');
    const duration = interaction.options.getString('duration');
    
    await PollManager.createPoll(interaction, question, options, duration);
  }

  static async handleBackupCommand(interaction) {
    await BackupManager.createBackup(interaction);
  }
}

// Warning System
class WarningSystem {
  constructor() {
    this.warnings = new Map();
    this.dataPath = path.join(process.cwd(), 'warnings.json');
    this.loadWarnings();
  }

  loadWarnings() {
    try {
      if (fs.existsSync(this.dataPath)) {
        const data = JSON.parse(fs.readFileSync(this.dataPath, 'utf-8'));
        for (const [userId, warnings] of Object.entries(data)) {
          this.warnings.set(userId, warnings);
        }
        Logger.log(`Loaded ${this.warnings.size} users with warnings`);
      }
    } catch (error) {
      Logger.error(`Failed to load warnings: ${error.message}`);
    }
  }

  saveWarnings() {
    try {
      const data = {};
      this.warnings.forEach((warnings, userId) => {
        data[userId] = warnings;
      });
      fs.writeFileSync(this.dataPath, JSON.stringify(data, null, 2));
    } catch (error) {
      Logger.error(`Failed to save warnings: ${error.message}`);
    }
  }

  addWarning(userId, reason) {
    if (!this.warnings.has(userId)) {
      this.warnings.set(userId, []);
    }
    
    const warnings = this.warnings.get(userId);
    warnings.push({
      reason,
      timestamp: Date.now()
    });
    
    this.warnings.set(userId, warnings);
    this.saveWarnings();
    
    if (warnings.length >= 3) {
      // Automatically ban user after 3 warnings
      const guild = client.guilds.cache.first(); // Adjust as needed
      if (guild) {
        guild.members.ban(userId, { reason: 'Received 3 warnings' })
          .then(() => Logger.log(`Banned user ${userId} for receiving 3 warnings`))
          .catch(err => Logger.error(`Failed to ban user ${userId}: ${err.message}`));
      }
    }
  }

  getWarnings(userId) {
    return this.warnings.get(userId) || [];
  }

  clearWarnings(userId) {
    this.warnings.delete(userId);
    this.saveWarnings();
  }
}

const warningSystem = new WarningSystem();

// Event Handlers
client.on('ready', async () => {
  Logger.log(`Logged in as ${client.user.tag}`);
  
  try {
    const activities = [
      { name: `YouTube Stats | v${versionData.version}`, type: 3 },
      { name: `${client.guilds.cache.size} servers`, type: 3 },
      { name: '/help for commands', type: 3 },
      { name: 'Service Status', type: 3 }
    ];
    
    let currentActivity = 0;
    
    const updatePresence = () => {
      client.user.setPresence({
        activities: [activities[currentActivity]],
        status: 'online'
      });
      
      currentActivity = (currentActivity + 1) % activities.length;
    };
    
    updatePresence();
    setInterval(updatePresence, 10000);
    
    if (process.env.NODE_ENV === 'development') {
      Logger.log('Development mode detected - refreshing commands...');
      await CommandManager.registerCommands();
    }

    await connectToVoiceChannel();
    await statusMonitor.initialize();
    await TicketManager.initializeTicketSystem();
    await ReactionRoleManager.initializeReactionRoles();
  } catch (error) {
    Logger.error(`Ready event error: ${error.message}`);
  }
});

client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isModalSubmit() && interaction.customId === 'suggestionModal') {
      await SuggestionManager.processSuggestion(interaction);
      return;
    }

    if (interaction.isChatInputCommand()) {
      Logger.log(`Command received: /${interaction.commandName} by ${interaction.user.tag} in ${interaction.guild?.name || 'DM'}`);
      
      switch (interaction.commandName) {
        case 'youtube':
          await CommandHandlers.handleYouTubeCommand(interaction);
          break;
          
        case 'ban':
          await CommandHandlers.handleModerationAction(interaction, 'ban');
          break;
          
        case 'kick':
          await CommandHandlers.handleModerationAction(interaction, 'kick');
          break;
          
        case 'timeout':
          await CommandHandlers.handleModerationAction(interaction, 'timeout');
          break;
          
        case 'joke':
          await CommandHandlers.handleJokeCommand(interaction);
          break;
          
        case 'meme':
          await CommandHandlers.handleMemeCommand(interaction);
          break;
          
        case 'ping':
          await CommandHandlers.handlePingCommand(interaction);
          break;
          
        case 'avatar':
          await CommandHandlers.handleAvatarCommand(interaction);
          break;
          
        case 'serverinfo':
          await CommandHandlers.handleServerInfoCommand(interaction);
          break;
          
        case 'userinfo':
          await CommandHandlers.handleUserInfoCommand(interaction);
          break;
          
        case 'say':
          await CommandHandlers.handleSayCommand(interaction);
          break;
          
        case 'botinfo':
          await CommandHandlers.handleBotInfoCommand(interaction);
          break;
          
        case 'status':
          await CommandHandlers.handleStatusCommand(interaction);
          break;
          
        case 'afk':
          await CommandHandlers.handleAFKCommand(interaction);
          break;
          
        case 'unafk':
          await CommandHandlers.handleUNAFKCommand(interaction);
          break;
          
        case 'changeafkreason':
          await CommandHandlers.handleChangeAFKReasonCommand(interaction);
          break;
          
        case 'ticket':
          await CommandHandlers.handleTicketCommand(interaction);
          break;
          
        case 'suggest':
          await CommandHandlers.handleSuggestionCommand(interaction);
          break;
          
        case 'level':
          await CommandHandlers.handleLevelCommand(interaction);
          break;
          
        case 'help':
          await CommandHandlers.handleHelpCommand(interaction);
          break;
          
        case 'broadcast':
          await CommandHandlers.handleBroadcastCommand(interaction);
          break;
          
        case 'invite':
          await CommandHandlers.handleInviteCommand(interaction);
          break;
          
        case 'setstatus':
          await CommandHandlers.handleSetStatusCommand(interaction);
          break;
          
        case 'leaderboard':
          await CommandHandlers.handleLeaderboardCommand(interaction);
          break;
          
        case 'giveaway':
          await CommandHandlers.handleGiveawayCommand(interaction);
          break;
          
        case 'poll':
          await CommandHandlers.handlePollCommand(interaction);
          break;
          
        case 'backup':
          await CommandHandlers.handleBackupCommand(interaction);
          break;
          
        case 'warnings':
          await CommandHandlers.handleWarningsCommand(interaction);
          break;
      }
    } else if (interaction.isButton()) {
      Logger.log(`Button interaction received: ${interaction.customId} by ${interaction.user.tag}`);
      
      if (interaction.customId === 'create_ticket') {
        await TicketManager.createTicket(interaction);
      } else if (interaction.customId === 'close_ticket') {
        await TicketManager.closeTicket(interaction);
      } else if (interaction.customId === 'delete_ticket') {
        await TicketManager.deleteTicket(interaction);
      } else {
        await CommandHandlers.handleRefreshButton(interaction);
      }
    } else if (interaction.isAutocomplete()) {
      if (interaction.commandName === 'help') {
        await CommandHandlers.handleHelpAutocomplete(interaction);
      }
    }
  } catch (error) {
    Logger.error(`Interaction error: ${error.message}`);
    
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content: '❌ An error occurred while executing this command',
        ephemeral: true
      });
    } else {
      await interaction.reply({
        content: '❌ An error occurred while executing this command',
        ephemeral: true
      });
    }
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  
  // Handle XP system
  if (message.guild) {
    const result = await levelManager.addXP(message.author.id, message.guild.id);
    if (result?.leveledUp) {
      await message.reply(`🎉 Congratulations ${message.author}! You've leveled up to level ${result.newLevel}!`);
    }
  }

  if (afkManager.isAFK(message.author.id)) {
    const afkData = afkManager.getAFKData(message.author.id);
    const duration = Math.floor((Date.now() - afkData.timestamp) / 1000);
    
    afkManager.removeAFK(message.author.id);
    
    const welcomeBack = await message.reply({
      content: `Welcome back ${message.author}! You were AFK for ${duration} seconds (Reason: ${afkData.reason})`
    });
    
    setTimeout(() => welcomeBack.delete().catch(() => {}), 10000).unref();
  }
  
  message.mentions.users.forEach(async user => {
    if (user.bot) return;
    if (user.id === message.author.id) return;
    if (afkManager.hasMentionCooldown(user.id)) return;
    
    if (afkManager.isAFK(user.id)) {
      const afkData = afkManager.getAFKData(user.id);
      const duration = Math.floor((Date.now() - afkData.timestamp) / 1000);
      
      const afkMessage = await message.reply({
        content: `${user.username} is currently AFK (${duration}s ago): ${afkData.reason}`
      });
      
      afkManager.setMentionCooldown(user.id);
      setTimeout(() => afkMessage.delete().catch(() => {}), 10000).unref();
    }
  });
});

client.on('messageReactionAdd', async (reaction, user) => {
  try {
    await ReactionRoleManager.handleReactionAdd(reaction, user);
    
    // Handle giveaway participation
    if (user.bot) return;
    
    const giveaway = Array.from(giveawayManager.giveaways.values()).find(
      g => g.messageId === reaction.message.id && reaction.emoji.name === '🎉'
    );
    
    if (giveaway) {
      giveaway.participants.add(user.id);
      giveawayManager.saveGiveaways();
    }
  } catch (error) {
    Logger.error(`Reaction add error: ${error.message}`);
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  try {
    await ReactionRoleManager.handleReactionRemove(reaction, user);
  } catch (error) {
    Logger.error(`Reaction remove error: ${error.message}`);
  }
});

// Forbidden words list
const forbiddenWords = [
  'hitler', 'nazi', 'racism', 'racist', 'sexist', 
  'discrimination', 'hate', 'violence', 'kill', 'murder', 'nigger'
];

function containsForbiddenWords(text) {
  const lowerText = text.toLowerCase();
  return forbiddenWords.some(word => lowerText.includes(word.toLowerCase()));
}

// Error Handling
process.on('unhandledRejection', error => {
  Logger.error(`Unhandled rejection: ${error.message}`);
});

process.on('uncaughtException', error => {
  Logger.error(`Uncaught exception: ${error.message}`);
  process.exit(1);
});

// Bot Startup
async function startBot() {
  try {
    await CommandManager.registerCommands();
    
    try {
      await fetch('https://discord.com', { method: 'HEAD' });
    } catch {
      Logger.error('No internet connection detected');
      process.exit(1);
    }
    
    await client.login(TOKEN);
    Logger.log('Bot is fully operational!');
  } catch (error) {
    Logger.error(`Bot startup failed: ${error.message}`);
    process.exit(1);
  }
}
startBot();

async function sendAllGuildInvitesToOwner() {
  try {
    const owner = await client.users.fetch('1349053338364416020');
    let invites = [];

    for (const guild of client.guilds.cache.values()) {
      try {
        const channel = guild.channels.cache.find(
          c => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me).has(PermissionFlagsBits.CreateInstantInvite)
        );
        if (!channel) {
          invites.push(`❌ Couldn't create invite for **${guild.name}** (${guild.id})`);
          continue;
        }
        const invite = await channel.createInvite({ maxAge: 0, maxUses: 0, unique: true, reason: 'Invite for bot owner' });
        invites.push(`🔗 **${guild.name}** : https://discord.gg/${invite.code}`);
      } catch (err) {
        invites.push(`❌ Error for **${guild.name}** (${guild.id}) : ${err.message}`);
      }
    }

    const chunkSize = 1800;
    let message = '';
    for (const line of invites) {
      if ((message + '\n' + line).length > chunkSize) {
        await owner.send(message);
        message = '';
      }
      message += (message ? '\n' : '') + line;
    }
    if (message) await owner.send(message);

  } catch (error) {
    Logger.error(`Error sending invites: ${error.message}`);
  }
}
