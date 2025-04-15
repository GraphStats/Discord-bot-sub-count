// 📦 Required dependencies
import { Client, GatewayIntentBits, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, SlashCommandBuilder, REST, Routes, InteractionType, PermissionFlagsBits } from 'discord.js';
import dotenv from 'dotenv';
import fs from 'fs';
import fetch from 'node-fetch';

dotenv.config();

const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers] });

const versionFile = './version.json';
let versionData;
try {
    versionData = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
} catch {
    versionData = { version: '1.0.0' };
}

function incrementVersion(version) {
    let parts = version.split('.').map(Number);
    if (parts[2] < 9) parts[2]++;
    else {
        parts[2] = 0;
        if (parts[1] < 9) parts[1]++;
        else {
            parts[1] = 0;
            parts[0]++;
        }
    }
    return parts.join('.');
}

const newVersion = incrementVersion(versionData.version);
versionData.version = newVersion;
fs.writeFileSync(versionFile, JSON.stringify(versionData, null, 2));

const cooldowns = new Map();

client.once('ready', () => {
    console.log(`${client.user.tag} is online! 🟢`);
    client.user.setPresence({
        activities: [{ name: `V${versionData.version}`, type: 0 }],
        status: 'online'
    });
});

async function getChannelInfo(channelName) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(channelName)}&type=channel&key=${YOUTUBE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    const channelId = data.items?.[0]?.id?.channelId;
    if (!channelId) return { channelId: null, channelTitle: null };

    const detailsUrl = `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${channelId}&key=${YOUTUBE_API_KEY}`;
    const detailsRes = await fetch(detailsUrl);
    const details = await detailsRes.json();
    const channelTitle = details.items?.[0]?.snippet?.title;

    return { channelId, channelTitle };
}

async function getSubscribers(channelId) {
    const res = await fetch(`https://backend.mixerno.space/api/youtube/estv3/${channelId}`);
    const data = await res.json();
    return data.items?.[0]?.statistics?.subscriberCount || 0;
}

const commands = [
    new SlashCommandBuilder()
        .setName('subscribers')
        .setDescription('Get YouTube channel subscriber count')
        .addStringOption(option => option.setName('channel').setDescription('YouTube channel name').setRequired(true)),

    new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a user')
        .addUserOption(option => option.setName('target').setDescription('User to ban').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),

    new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kick a user')
        .addUserOption(option => option.setName('target').setDescription('User to kick').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),

    new SlashCommandBuilder()
        .setName('joke')
        .setDescription('Get a random fun joke')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'subscribers') {
        const channelName = interaction.options.getString('channel');
        const { channelId, channelTitle } = await getChannelInfo(channelName);

        if (!channelId) return interaction.reply({ content: 'Channel not found ❌', ephemeral: true });

        const count = await getSubscribers(channelId);

        const embed = new EmbedBuilder()
            .setTitle(`${channelTitle}`)
            .setDescription(`📊 Subscribers: **${count.toLocaleString()}**`)
            .setColor('Blue');

        const button = new ButtonBuilder()
            .setCustomId(`reload-${channelId}`)
            .setLabel('🔁 Reload')
            .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(button);

        await interaction.reply({ embeds: [embed], components: [row] });
    }

    if (interaction.commandName === 'ban') {
        const user = interaction.options.getUser('target');
        await interaction.guild.members.ban(user);
        interaction.reply(`${user.tag} has been banned 🚫`);
    }

    if (interaction.commandName === 'kick') {
        const user = interaction.options.getUser('target');
        const member = interaction.guild.members.cache.get(user.id);
        if (member) {
            await member.kick();
            interaction.reply(`${user.tag} has been kicked 👢`);
        } else {
            interaction.reply('User not found ❌');
        }
    }

    if (interaction.commandName === 'joke') {
        const jokes = [
            "Why don't scientists trust atoms? Because they make up everything!",
            "Why did the computer get cold? Because it forgot to close its Windows!",
            "Why do Java developers wear glasses? Because they don't C#!"
        ];
        const joke = jokes[Math.floor(Math.random() * jokes.length)];
        interaction.reply(joke);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;

    const [action, channelId] = interaction.customId.split('-');
    if (action !== 'reload') return;

    const now = Date.now();
    const lastClick = cooldowns.get(interaction.user.id) || 0;

    if (now - lastClick < 5000) {
        return interaction.reply({ content: '⏱ You are clicking too fast! Please wait 5 seconds.', ephemeral: true });
    }

    cooldowns.set(interaction.user.id, now);

    const count = await getSubscribers(channelId);
    const embed = new EmbedBuilder()
        .setTitle(`Updated Subscriber Count`)
        .setDescription(`📊 Subscribers: **${count.toLocaleString()}**`)
        .setColor('Green');

    await interaction.update({ embeds: [embed] });
});

(async () => {
    try {
        console.log('Registering slash commands...');
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('Slash commands registered ✅');
        await client.login(TOKEN);
    } catch (err) {
        console.error(err);
    }
})();
