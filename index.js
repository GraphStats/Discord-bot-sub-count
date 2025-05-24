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
  ChannelType
} from 'discord.js';
import fetch from 'node-fetch';
import { setTimeout as sleep } from 'node:timers/promises';
import pLimit from 'p-limit';
import { AbortController } from 'abort-controller';

// Configuration
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const STATUS_CHANNEL_ID = process.env.STATUS_CHANNEL_ID;
const CHECK_INTERVAL = 60 * 1000;
const API_CONCURRENCY_LIMIT = 3;

// Services to monitor
const services = [
  { name: 'FastCount', url: 'https://fastcount.vercel.app/' },
  { name: 'Fastcount API', url: 'https://fastcount.vercel.app/' },
  { name: 'Save Grapher', url: 'http://89.213.149.192:8005/' },
  { name: 'NotStatify', fixedStatus: 'Up' },
  { name: '444 Count', url: 'https://444-count-beta.vercel.app/' },
  { name: 'Top 50 MDM', fixedStatus: 'Down' },
  { name: 'FastCount 2', url: 'https://fastcount-2-beta.vercel.app/' },
];

// Validate environment variables
const requiredEnvVars = ['TOKEN', 'CLIENT_ID', 'YOUTUBE_API_KEY', 'LOG_CHANNEL_ID'];
const missingVars = requiredEnvVars.filter(varname => !process.env[varname]);

if (missingVars.length > 0) {
  console.error('[ERROR] Missing required environment variables:', missingVars.join(', '));
  process.exit(1);
}

// Enhanced logging system with Discord channel integration
class Logger {
  static async sendToLogChannel(message, type = 'INFO') {
    try {
      if (!LOG_CHANNEL_ID) return;
      
      const channel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
      if (!channel?.isTextBased()) return;
      
      const timestamp = new Date().toISOString();
      const logMessage = `[${timestamp}] [${type}] ${message}`;
      
      await channel.send({
        content: `\`\`\`${logMessage.length > 1900 ? logMessage.substring(0, 1900) + '...' : logMessage}\`\`\``
      });
    } catch (error) {
      console.error('Failed to send log to Discord channel:', error);
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
    GatewayIntentBits.GuildModeration
  ],
  allowedMentions: { parse: [], repliedUser: false }
});

// Version configuration
const versionData = { 
  version: '2.1.1',
  features: [
    'YouTube Stats Tracking',
    'Moderation Tools',
    'Fun Commands',
    'Utility Commands',
    'Service Status Monitoring'
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
        name: '✅ Online',
        value: upServices.map(s => `**${s.name}**`).join('\n'),
        inline: true,
      });
    }

    if (downServices.length) {
      embed.addFields({
        name: '❌ Offline',
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
      Logger.warn('STATUS_CHANNEL_ID not set - status monitoring disabled');
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
      // Use cache if available and recent
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
            .setRequired(false))
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

      // Log the moderation action
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
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Reddit API: ${response.status}`);
      
      const [data] = await response.json();
      if (!data || !data.data || !data.data.children || data.data.children.length === 0) {
        throw new Error('No posts found');
      }
      
      const post = data.data.children[0].data;
      if (post.over_18 && !interaction.channel.nsfw) {
        return interaction.editReply({
          content: '🔞 This meme is NSFW and can only be posted in NSFW channels.'
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
        content: `❌ Failed to get meme from r/${subreddit}. Please try another subreddit.`
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
        { name: '🛠️ Status', value: latency < 200 ? '✅ Excellent' : latency < 500 ? '🟢 Good' : '🔴 Slow', inline: true }
      )
      .setColor(latency < 200 ? 0x00FF00 : latency < 500 ? 0xFFFF00 : 0xFF0000)
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
}

// Event Handlers
client.on('ready', async () => {
  Logger.log(`Logged in as ${client.user.tag}`);
  
  try {
    // Set presence with rotating status
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
    setInterval(updatePresence, 30000);
    
    // Application commands sync
    if (process.env.NODE_ENV === 'development') {
      Logger.log('Development mode detected - refreshing commands...');
      await CommandManager.registerCommands();
    }

    // Initialize status monitoring
    await statusMonitor.initialize();
  } catch (error) {
    Logger.error(`Ready event error: ${error.message}`);
  }
});

client.on('interactionCreate', async interaction => {
  try {
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
      }
    } else if (interaction.isButton()) {
      Logger.log(`Button interaction received: ${interaction.customId} by ${interaction.user.tag}`);
      await CommandHandlers.handleRefreshButton(interaction);
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
    
    // Check connectivity before login
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
