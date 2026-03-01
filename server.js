require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const MEMORY_FILE = path.join(__dirname, 'memory.md');
const HISTORY_FILE = path.join(__dirname, 'history.json');
const GLM_API_KEY = process.env.GLM_API_KEY;
const GLM_API_URL = process.env.GLM_API_URL;

// Store conversation history for context (up to 200 exchanges - ~50k tokens)
let conversationHistory = [];
const MAX_HISTORY = 200;

// Load conversation history from file on startup
async function loadConversationHistory() {
  try {
    const data = await fs.readFile(HISTORY_FILE, 'utf-8');
    conversationHistory = JSON.parse(data);
    console.log(`Loaded ${conversationHistory.length} messages from history.json`);
  } catch (error) {
    // File doesn't exist yet, start fresh
    conversationHistory = [];
  }
}

// Save conversation history to file
async function saveConversationHistory() {
  try {
    await fs.writeFile(HISTORY_FILE, JSON.stringify(conversationHistory, null, 2), 'utf-8');
  } catch (error) {
    console.error('Error saving conversation history:', error);
  }
}

// Initialize history on startup
loadConversationHistory();

// Dice rolling system
function rollD20() {
  return Math.floor(Math.random() * 20) + 1;
}

function rollWithAdvantage() {
  const roll1 = rollD20();
  const roll2 = rollD20();
  return { rolls: [roll1, roll2], result: Math.max(roll1, roll2), type: 'advantage' };
}

function rollWithDisadvantage() {
  const roll1 = rollD20();
  const roll2 = rollD20();
  return { rolls: [roll1, roll2], result: Math.min(roll1, roll2), type: 'disadvantage' };
}

function rollNormal() {
  const roll = rollD20();
  return { rolls: [roll], result: roll, type: 'normal' };
}

function rollForStat(statValue) {
  if (statValue >= 3) return rollWithAdvantage();
  if (statValue <= 1) return rollWithDisadvantage();
  return rollNormal();
}

// Parse player stats from memory
function parsePlayerStats(memory) {
  const stats = { name: 'Adventurer', might: 2, agility: 2, mind: 2, presence: 2, exists: false };

  const statsMatch = memory.match(/## 🎭 PLAYER_STATS[\s\S]*?(?=---|\n##|$)/);
  if (statsMatch) {
    const section = statsMatch[0];
    const nameMatch = section.match(/\*\*Name:\*\*\s*(.+)/i);
    const mightMatch = section.match(/\*\*MIGHT:\*\*\s*(\d+)/i);
    const agilityMatch = section.match(/\*\*AGILITY:\*\*\s*(\d+)/i);
    const mindMatch = section.match(/\*\*MIND:\*\*\s*(\d+)/i);
    const presenceMatch = section.match(/\*\*PRESENCE:\*\*\s*(\d+)/i);

    if (nameMatch) stats.name = nameMatch[1].trim();
    if (mightMatch) stats.might = parseInt(mightMatch[1]);
    if (agilityMatch) stats.agility = parseInt(agilityMatch[1]);
    if (mindMatch) stats.mind = parseInt(mindMatch[1]);
    if (presenceMatch) stats.presence = parseInt(presenceMatch[1]);
    stats.exists = true;
  }

  return stats;
}

// Parse exhaustion state from memory
function parseExhaustionState(memory) {
  const state = {
    hoursAwake: 0,
    lastSleptDay: 1,
    lastSleptTime: 'Morning',
    exhaustionLevel: 'Rested', // Rested, Tired, Exhausted, Unconscious
    bedBonus: 0 // Hours of bonus from quality bed
  };

  const exhaustionMatch = memory.match(/## 😴 EXHAUSTION[\s\S]*?(?=---|\n##|$)/);
  if (exhaustionMatch) {
    const section = exhaustionMatch[0];
    const hoursMatch = section.match(/\*\*Hours Awake:\*\*\s*(\d+)/i);
    const lastSleptDayMatch = section.match(/\*\*Last Slept Day:\*\*\s*(\d+)/i);
    const lastSleptTimeMatch = section.match(/\*\*Last Slept Time:\*\*\s*([^\n]+)/i);
    const levelMatch = section.match(/\*\*Exhaustion Level:\*\*\s*([^\n]+)/i);
    const bonusMatch = section.match(/\*\*Bed Bonus Hours:\*\*\s*(-?\d+)/i);

    if (hoursMatch) state.hoursAwake = parseInt(hoursMatch[1]);
    if (lastSleptDayMatch) state.lastSleptDay = parseInt(lastSleptDayMatch[1]);
    if (lastSleptTimeMatch) state.lastSleptTime = lastSleptTimeMatch[1].trim();
    if (levelMatch) state.exhaustionLevel = levelMatch[1].trim();
    if (bonusMatch) state.bedBonus = parseInt(bonusMatch[1]);
  }

  return state;
}

// Parse character voice profile from memory
function parseCharacterVoice(memory) {
  const voice = {
    coreTone: '',
    significantMemories: [],
    values: [],
    lastUpdatedDay: 0
  };

  const voiceMatch = memory.match(/## 🎭 CHARACTER_VOICE[\s\S]*?(?=---|\n##|$)/);
  if (voiceMatch) {
    const section = voiceMatch[0];
    const toneMatch = section.match(/\*\*Core Tone:\*\*\s*([^\n]+)/i);
    const lastUpdatedMatch = section.match(/\*\*Last Updated Day:\*\*\s*(\d+)/i);

    if (toneMatch) voice.coreTone = toneMatch[1].trim();
    if (lastUpdatedMatch) voice.lastUpdatedDay = parseInt(lastUpdatedMatch[1]);

    // Parse significant memories
    const memoriesMatch = section.match(/\*\*Significant Memories:\*\*\s*([\s\S]*?)(?=\*\*Values:|$)/i);
    if (memoriesMatch) {
      const lines = memoriesMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
      voice.significantMemories = lines.map(l => l.replace(/^-\s*/, '').trim());
    }

    // Parse values
    const valuesMatch = section.match(/\*\*Values:\*\*\s*([\s\S]*?)(?=\*\*|---|\n##|$)/i);
    if (valuesMatch) {
      const lines = valuesMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
      voice.values = lines.map(l => l.replace(/^-\s*/, '').trim());
    }
  }

  return voice;
}

// Parse current day from memory
function parseCurrentDay(memory) {
  const dayMatch = memory.match(/\*\*Day Count:\*\*\s*(\d+)/i);
  return dayMatch ? parseInt(dayMatch[1]) : 1;
}

// Parse current time from memory
function parseCurrentTime(memory) {
  const timeMatch = memory.match(/\*\*Time of Day:\*\*\s*([^\n]+)/i);
  return timeMatch ? timeMatch[1].trim() : 'Morning';
}

// ============================================
// DOUBLE-ENTRY ACCOUNTING SYSTEM
// ============================================

// Parse coin ledger from memory
function parseCoinLedger(memory) {
  const ledger = {
    entries: [],
    balance: { pp: 0, gp: 0, sp: 0, cp: 0 }
  };

  const ledgerMatch = memory.match(/## 💰 COIN_LEDGER[\s\S]*?(?=---|\n## [^💰]|$)/);
  if (ledgerMatch) {
    const section = ledgerMatch[0];

    // Parse balance
    const ppMatch = section.match(/\*\*Balance PP:\*\*\s*(\d+)/i);
    const gpMatch = section.match(/\*\*Balance GP:\*\*\s*(\d+)/i);
    const spMatch = section.match(/\*\*Balance SP:\*\*\s*(\d+)/i);
    const cpMatch = section.match(/\*\*Balance CP:\*\*\s*(\d+)/i);

    if (ppMatch) ledger.balance.pp = parseInt(ppMatch[1]);
    if (gpMatch) ledger.balance.gp = parseInt(gpMatch[1]);
    if (spMatch) ledger.balance.sp = parseInt(spMatch[1]);
    if (cpMatch) ledger.balance.cp = parseInt(cpMatch[1]);

    // Parse entries
    const entryRegex = /\|\s*(\d+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g;
    let match;
    while ((match = entryRegex.exec(section)) !== null) {
      if (match[1] !== 'ID' && !match[1].includes('-')) { // Skip header row
        ledger.entries.push({
          id: parseInt(match[1]),
          date: match[2].trim(),
          description: match[3].trim(),
          debit: match[4].trim(),
          credit: match[5].trim()
        });
      }
    }
  }

  return ledger;
}

// Convert all coins to copper for calculations
function toCopper(coins) {
  return (coins.pp || 0) * 1000 + (coins.gp || 0) * 100 + (coins.sp || 0) * 10 + (coins.cp || 0);
}

// Convert copper to mixed denominations
function fromCopper(copper) {
  const pp = Math.floor(copper / 1000);
  copper %= 1000;
  const gp = Math.floor(copper / 100);
  copper %= 100;
  const sp = Math.floor(copper / 10);
  const cp = copper % 10;
  return { pp, gp, sp, cp };
}

// Parse coin amount from text (e.g., "5 gold", "3 sp", "2 silver and 5 copper")
function parseCoinAmount(text) {
  const coins = { pp: 0, gp: 0, sp: 0, cp: 0 };
  const lowerText = text.toLowerCase();

  // Match patterns like "5 gold", "3 gp", "10 silver pieces", etc.
  const patterns = [
    { regex: /(\d+)\s*(?:platinum|pp)/gi, key: 'pp' },
    { regex: /(\d+)\s*(?:gold|gp)/gi, key: 'gp' },
    { regex: /(\d+)\s*(?:silver|sp)/gi, key: 'sp' },
    { regex: /(\d+)\s*(?:copper|cp)/gi, key: 'cp' }
  ];

  patterns.forEach(({ regex, key }) => {
    let match;
    while ((match = regex.exec(lowerText)) !== null) {
      coins[key] += parseInt(match[1]);
    }
  });

  return coins;
}

// Detect coin transactions from DM response
function detectCoinTransactions(dmResponse, playerAction) {
  const transactions = [];
  const combined = (playerAction + ' ' + dmResponse).toLowerCase();

  // Patterns for gaining coins
  const gainPatterns = [
    /(?:receive|gain|earn|find|loot|collect|pick up|given|handed|reward(?:ed)?)\s+(\d+[^.]*?(?:gold|silver|copper|platinum|gp|sp|cp|pp)[^.]*)/gi,
    /(\d+[^.]*?(?:gold|silver|copper|platinum|gp|sp|cp|pp)[^.]*?)(?:\s+(?:falls?|drops?|rolls?|scattered|spill))/gi,
    /(?:sells?|sold)\s+[^.]+?\s+for\s+(\d+[^.]*?(?:gold|silver|copper|platinum|gp|sp|cp|pp)[^.]*)/gi
  ];

  // Patterns for losing coins
  const lossPatterns = [
    /(?:pay|paid|spend|spent|hand over|give|cost|costs|charge[ds]?|buy|bought|purchase[ds]?)\s+(\d+[^.]*?(?:gold|silver|copper|platinum|gp|sp|cp|pp)[^.]*)/gi,
    /(\d+[^.]*?(?:gold|silver|copper|platinum|gp|sp|cp|pp)[^.]*?)\s+(?:for|to buy|to purchase|as payment|in exchange)/gi
  ];

  // Check for gains
  gainPatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(combined)) !== null) {
      const coins = parseCoinAmount(match[1]);
      if (toCopper(coins) > 0) {
        transactions.push({
          type: 'credit',
          coins,
          description: match[0].substring(0, 50)
        });
      }
    }
  });

  // Check for losses
  lossPatterns.forEach(pattern => {
    let match;
    while ((match = pattern.exec(combined)) !== null) {
      const coins = parseCoinAmount(match[1]);
      if (toCopper(coins) > 0) {
        transactions.push({
          type: 'debit',
          coins,
          description: match[0].substring(0, 50)
        });
      }
    }
  });

  return transactions;
}

// Apply transactions and update ledger in memory
function applyTransactionsToMemory(memory, transactions, currentDay, currentTime) {
  if (transactions.length === 0) return memory;

  let ledger = parseCoinLedger(memory);
  let balance = { ...ledger.balance };
  let nextId = ledger.entries.length > 0 ? Math.max(...ledger.entries.map(e => e.id)) + 1 : 1;
  const newEntries = [];

  transactions.forEach(tx => {
    const entry = {
      id: nextId++,
      date: `Day ${currentDay} - ${currentTime}`,
      description: tx.description,
      debit: '',
      credit: ''
    };

    if (tx.type === 'credit') {
      // Gaining coins
      entry.credit = formatCoins(tx.coins);
      balance.pp += tx.coins.pp;
      balance.gp += tx.coins.gp;
      balance.sp += tx.coins.sp;
      balance.cp += tx.coins.cp;
    } else {
      // Losing coins
      entry.debit = formatCoins(tx.coins);
      // Convert to copper, subtract, convert back
      let totalCopper = toCopper(balance);
      const costCopper = toCopper(tx.coins);
      totalCopper = Math.max(0, totalCopper - costCopper);
      balance = fromCopper(totalCopper);
    }

    newEntries.push(entry);
  });

  // Update memory with new ledger
  const ledgerSection = generateLedgerSection(ledger.entries.concat(newEntries), balance);

  // Replace or add ledger section
  if (memory.includes('## 💰 COIN_LEDGER')) {
    memory = memory.replace(/## 💰 COIN_LEDGER[\s\S]*?(?=---|\n## [^💰]|$)/, ledgerSection + '\n\n');
  } else {
    // Insert after COIN_PURSE section
    const coinPurseEnd = memory.indexOf('---', memory.indexOf('## 💰 COIN_PURSE'));
    if (coinPurseEnd !== -1) {
      memory = memory.slice(0, coinPurseEnd + 3) + '\n\n' + ledgerSection + memory.slice(coinPurseEnd + 3);
    }
  }

  // Also update COIN_PURSE for backward compatibility
  memory = updateCoinPurse(memory, balance, currentDay, currentTime);

  return memory;
}

// Format coins for display
function formatCoins(coins) {
  const parts = [];
  if (coins.pp > 0) parts.push(`${coins.pp}pp`);
  if (coins.gp > 0) parts.push(`${coins.gp}gp`);
  if (coins.sp > 0) parts.push(`${coins.sp}sp`);
  if (coins.cp > 0) parts.push(`${coins.cp}cp`);
  return parts.join(' ') || '-';
}

// Generate ledger section markdown
function generateLedgerSection(entries, balance) {
  let section = `## 💰 COIN_LEDGER
**Balance PP:** ${balance.pp}
**Balance GP:** ${balance.gp}
**Balance SP:** ${balance.sp}
**Balance CP:** ${balance.cp}
**Total Value:** ${toCopper(balance)} copper

| ID | Date | Description | Debit | Credit |
|----|------|-------------|-------|--------|
`;

  entries.slice(-20).forEach(entry => { // Keep last 20 entries visible
    section += `| ${entry.id} | ${entry.date} | ${entry.description} | ${entry.debit} | ${entry.credit} |\n`;
  });

  return section;
}

// Update COIN_PURSE section with current balance
function updateCoinPurse(memory, balance, currentDay, currentTime) {
  const newCoinPurse = `## 💰 COIN_PURSE
**Platinum (pp):** ${balance.pp}
**Gold (gp):** ${balance.gp}
**Silver (sp):** ${balance.sp}
**Copper (cp):** ${balance.cp}
**Last Updated:** Day ${currentDay}, ${currentTime}

**Conversion:** 10 cp = 1 sp, 10 sp = 1 gp, 10 gp = 1 pp`;

  // Replace COIN_PURSE section
  return memory.replace(
    /## 💰 COIN_PURSE[\s\S]*?(?=---|\n## [^💰])/,
    newCoinPurse + '\n\n'
  );
}

// Bed quality tiers and their effects
const BED_QUALITY = {
  STREET: { name: 'Street', exhaustionFloor: 4, bonusHours: -2 },
  POOR: { name: 'Poor Bed', exhaustionFloor: 2, bonusHours: 0 },
  COMMON: { name: 'Common Bed', exhaustionFloor: 0, bonusHours: 0 },
  FINE: { name: 'Fine Bed', exhaustionFloor: 0, bonusHours: 1 },
  NOBLE: { name: 'Noble Bed', exhaustionFloor: 0, bonusHours: 2, statusEffect: 'Energized' }
};

// Calculate exhaustion debuffs based on hours awake
function getExhaustionDebuffs(hoursAwake, bedBonus = 0) {
  const effectiveHours = hoursAwake - bedBonus;
  if (effectiveHours < 14) {
    return { level: 'Rested', debuffs: null };
  } else if (effectiveHours < 20) {
    return { level: 'Tired', debuffs: { all: -1 } }; // -1 to all stats
  } else if (effectiveHours < 28) {
    return { level: 'Exhausted', debuffs: { all: -2 } }; // -2 to all stats
  } else if (effectiveHours < 36) {
    return { level: 'Severely Exhausted', debuffs: { all: -3 } }; // -3 to all stats
  } else {
    return { level: 'Unconscious', debuffs: { unconscious: true } };
  }
}

// Fantasy date generator
function generateFantasyDate() {
  const months = ['Primember', 'Solstice', 'Harvestmoon', 'Frostfall', 'Starlight', 'Dawnrise',
                  'Goldleaf', 'Shadowmere', 'Thornfall', 'Ironveil', 'Cinder', 'Wynter'];
  const eras = ['of the Age of Wonder', 'of the Third Era', 'of the Age of Heroes',
                'of the New Dawn', 'of the Age of Shadows', 'of the Crimson Age'];
  const randomMonth = months[Math.floor(Math.random() * months.length)];
  const randomDay = Math.floor(Math.random() * 28) + 1;
  const randomYear = Math.floor(Math.random() * 900) + 100;
  const randomEra = eras[Math.floor(Math.random() * eras.length)];
  return `${randomDay} ${randomMonth}, ${randomYear} ${randomEra}`;
}

// Parse event pool from memory (events since last sleep)
function parseEventPool(memory) {
  const events = [];
  const poolMatch = memory.match(/## 📝 EVENT_POOL[\s\S]*?(?=---|\n##|$)/);
  if (poolMatch) {
    const section = poolMatch[0];
    const eventsMatch = section.match(/\*\*Events:\*\*\s*([\s\S]*?)(?=\*\*|---|\n##|$)/i);
    if (eventsMatch) {
      const lines = eventsMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
      lines.forEach(l => {
        events.push(l.replace(/^-\s*/, '').trim());
      });
    }
  }
  return events;
}

// Detect if player is trying to sleep
function detectSleepAttempt(message) {
  const sleepKeywords = [
    'go to sleep', 'go to bed', 'sleep', 'rest for the night',
    'lie down', 'take a nap', 'find a place to sleep', 'rent a room',
    'sleep at', 'sleep in', 'sleep on', 'fall asleep', 'get some rest',
    'rest until morning', 'sleep until', 'bed down', 'make camp and sleep'
  ];
  const lowerMessage = message.toLowerCase();
  return sleepKeywords.some(keyword => lowerMessage.includes(keyword));
}

// Detect bed quality from context
function detectBedQuality(message, dmResponse) {
  const combined = (message + ' ' + dmResponse).toLowerCase();

  if (combined.includes('noble') || combined.includes('luxury') || combined.includes('finest') || combined.includes('royal')) {
    return BED_QUALITY.NOBLE;
  } else if (combined.includes('fine') || combined.includes('quality') || combined.includes('comfortable inn')) {
    return BED_QUALITY.FINE;
  } else if (combined.includes('street') || combined.includes('ground') || combined.includes('alley') || combined.includes('outside') || combined.includes('forest floor') || combined.includes('camp')) {
    return BED_QUALITY.STREET;
  } else if (combined.includes('poor') || combined.includes('straw') || combined.includes('barn') || combined.includes('stable')) {
    return BED_QUALITY.POOR;
  }
  return BED_QUALITY.COMMON;
}

// Generate diary entry using LLM
async function generateDiaryEntry(memory, eventPool, characterVoice, exhaustionState, stats) {
  const eventsText = eventPool.length > 0
    ? eventPool.map((e, i) => `${i + 1}. ${e}`).join('\n')
    : 'A quiet day with no significant events.';

  const voiceContext = characterVoice.coreTone
    ? `Character's established voice/tone: ${characterVoice.coreTone}
Significant past memories that shaped them: ${characterVoice.significantMemories.join('; ') || 'None yet'}
Values they've demonstrated: ${characterVoice.values.join('; ') || 'Still developing'}`
    : 'This is the character\'s first diary entry. Establish their initial voice based on today\'s events.';

  const diaryPrompt = `You are writing a personal diary entry for ${stats.name}, a character in a fantasy RPG.

${voiceContext}

TODAY'S EVENTS (pool of things that happened since last sleep):
${eventsText}

CURRENT STATE:
- Hours awake: ${exhaustionState.hoursAwake}
- Current exhaustion: ${exhaustionState.exhaustionLevel}

INSTRUCTIONS:
- Write a first-person diary entry as ${stats.name}
- This is a PERSONAL diary - be emotional, reflective, human
- Don't just list events - share how they FELT about what happened
- Reference specific events but through the lens of personal meaning
- The character should reflect on relationships, fears, hopes, regrets
- Keep it 3-5 paragraphs
- Write naturally, like a real person's diary - not a formal report
- If this is the first entry, establish the character's voice
- If exhausted, the entry might be shorter or more raw

Write ONLY the diary entry text. No headers, no "Dear Diary", just the entry itself.`;

  const diaryResponse = await callGLM(
    [{ role: 'user', content: 'Write the diary entry.' }],
    diaryPrompt
  );

  return diaryResponse.trim();
}

// Update character voice profile based on recent diary entries (every 7 days)
async function updateCharacterVoice(memory, stats, currentDay) {
  // Get last 7 diary entries
  const diaryMatch = memory.match(/## 📖 DIARY[\s\S]*?(?=---|\n##|$)/);
  if (!diaryMatch) return null;

  const entries = [];
  const entryRegex = /### Day (\d+)[^\n]*\n([\s\S]*?)(?=### Day|\*\*Last Updated|$)/g;
  let match;
  while ((match = entryRegex.exec(diaryMatch[0])) !== null) {
    entries.push({ day: parseInt(match[1]), content: match[2].trim() });
  }

  if (entries.length < 3) return null; // Need at least 3 entries to analyze

  const recentEntries = entries.slice(-7).map(e => e.content).join('\n\n---\n\n');

  const voicePrompt = `Analyze these diary entries from ${stats.name} and extract their evolving character voice.

RECENT DIARY ENTRIES:
${recentEntries}

Based on these entries, determine:
1. Core Tone: A 1-2 sentence description of how this character writes/thinks (e.g., "Cautiously optimistic with dark humor", "Melancholic but determined")
2. Significant Memories: 3-5 key moments that clearly shaped them
3. Values: 3-5 things they clearly care about based on their reflections

Respond in this EXACT format:
CORE_TONE: [description]
MEMORIES:
- [memory 1]
- [memory 2]
- [memory 3]
VALUES:
- [value 1]
- [value 2]
- [value 3]`;

  const voiceResponse = await callGLM(
    [{ role: 'user', content: 'Analyze the character voice.' }],
    voicePrompt
  );

  // Parse the response
  const toneMatch = voiceResponse.match(/CORE_TONE:\s*([^\n]+)/i);
  const memoriesMatch = voiceResponse.match(/MEMORIES:\s*([\s\S]*?)(?=VALUES:|$)/i);
  const valuesMatch = voiceResponse.match(/VALUES:\s*([\s\S]*?)$/i);

  const newVoice = {
    coreTone: toneMatch ? toneMatch[1].trim() : '',
    significantMemories: [],
    values: [],
    lastUpdatedDay: currentDay
  };

  if (memoriesMatch) {
    const lines = memoriesMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
    newVoice.significantMemories = lines.map(l => l.replace(/^-\s*/, '').trim());
  }

  if (valuesMatch) {
    const lines = valuesMatch[1].split('\n').filter(l => l.trim().startsWith('-'));
    newVoice.values = lines.map(l => l.replace(/^-\s*/, '').trim());
  }

  return newVoice;
}

// Helper: Call LLM API (Anthropic format via z.ai)
async function callGLM(messages, systemPrompt = '') {
  try {
    const response = await axios.post(
      `${GLM_API_URL}/v1/messages`,
      {
        model: 'claude-3-5-opus-20241022',
        max_tokens: 4000,
        system: systemPrompt,
        messages: messages
      },
      {
        headers: {
          'x-api-key': GLM_API_KEY,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01'
        }
      }
    );

    return response.data.content[0].text;
  } catch (error) {
    console.error('LLM API Error:', error.response?.data || error.message);
    throw error;
  }
}

// Helper: Read memory.md
async function readMemory() {
  try {
    return await fs.readFile(MEMORY_FILE, 'utf-8');
  } catch (error) {
    console.error('Error reading memory:', error);
    return '';
  }
}

// Helper: Write memory.md
async function writeMemory(content) {
  try {
    await fs.writeFile(MEMORY_FILE, content, 'utf-8');
  } catch (error) {
    console.error('Error writing memory:', error);
    throw error;
  }
}

// API: Chat endpoint (two LLM calls)
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;

    // Read current memory
    let memory = await readMemory();

    // Parse player stats and exhaustion state
    const stats = parsePlayerStats(memory);
    const exhaustionState = parseExhaustionState(memory);
    const currentDay = parseCurrentDay(memory);
    const characterVoice = parseCharacterVoice(memory);

    // Check for unconsciousness (36+ hours awake)
    if (exhaustionState.hoursAwake >= 36) {
      // Handle unconsciousness - player collapses
      const unconsciousPrompt = `The player ${stats.name} has been awake for ${exhaustionState.hoursAwake} hours and collapses from exhaustion.

Describe what happens:
- They lose consciousness suddenly
- 8 hours pass while they're unconscious
- Something happens during this time (roll for an event):
  - Maybe someone steals some coins or an item
  - Maybe they wake up to a threatening situation (animal, bandit)
  - Maybe a kind stranger helps them
  - Maybe they just wake up cold and disoriented

Make it dramatic and consequential. They should lose some health from the ordeal.
Keep it to 2-3 paragraphs.`;

      const unconsciousResponse = await callGLM(
        [{ role: 'user', content: message }],
        unconsciousPrompt
      );

      // Update conversation history
      conversationHistory.push({ role: 'user', content: message });
      conversationHistory.push({ role: 'assistant', content: unconsciousResponse });
      if (conversationHistory.length > MAX_HISTORY) {
        conversationHistory = conversationHistory.slice(-MAX_HISTORY);
      }
      await saveConversationHistory();

      // Update memory for unconsciousness - reset hours, progress time, damage health
      const unconsciousWorldPrompt = `You are the World Builder. The player just collapsed from exhaustion.

CURRENT MEMORY:
${memory}

WHAT HAPPENED: ${unconsciousResponse}

Update memory to reflect:
1. 8 hours have passed (update WORLD_TIME appropriately)
2. Reset EXHAUSTION section: Hours Awake to 0, Exhaustion Level to "Tired" (not fully rested from forced unconsciousness)
3. Update PLAYER_STATE: Condition should reflect damage/injury from the ordeal
4. Clear EVENT_POOL (new day cycle)
5. Log what happened during unconsciousness
6. If anything was stolen, update COIN_PURSE or INVENTORY

Return ONLY the updated memory.md content.`;

      const updatedMemory = await callGLM(
        [{ role: 'user', content: 'Process unconsciousness event.' }],
        unconsciousWorldPrompt
      );

      let cleanedMemory = updatedMemory.trim();
      if (cleanedMemory.startsWith('```')) {
        cleanedMemory = cleanedMemory.split('\n').slice(1, -1).join('\n');
      }
      await writeMemory(cleanedMemory);

      return res.json({
        response: unconsciousResponse,
        memoryUpdated: true,
        rolls: null,
        stats: stats,
        unconscious: true
      });
    }

    // Check if player is trying to sleep
    const isSleepAttempt = detectSleepAttempt(message);
    const exhaustionDebuffs = getExhaustionDebuffs(exhaustionState.hoursAwake, exhaustionState.bedBonus);

    // If trying to sleep but not tired enough (less than 6 hours awake)
    if (isSleepAttempt && exhaustionState.hoursAwake < 6) {
      const cantSleepResponse = `You lie down and close your eyes, but sleep won't come. Your mind is too alert, your body too restless. You toss and turn for a while before giving up. Perhaps you need to tire yourself out more before you can truly rest.`;

      conversationHistory.push({ role: 'user', content: message });
      conversationHistory.push({ role: 'assistant', content: cantSleepResponse });
      await saveConversationHistory();

      return res.json({
        response: cantSleepResponse,
        memoryUpdated: false,
        rolls: null,
        stats: stats,
        cantSleep: true
      });
    }

    // Generate rolls for all stats (LLM decides which to use)
    const rolls = {
      might: rollForStat(stats.might),
      agility: rollForStat(stats.agility),
      mind: rollForStat(stats.mind),
      presence: rollForStat(stats.presence)
    };

    // Calculate exhaustion penalty (exhaustionDebuffs already defined above)
    const exhaustionPenalty = exhaustionDebuffs.debuffs?.all || 0;

    // Format rolls for LLM (include exhaustion penalty)
    const formatRoll = (name, stat, roll) => {
      const typeLabel = roll.type === 'advantage' ? 'ADV' : roll.type === 'disadvantage' ? 'DIS' : 'NRM';
      const rollStr = roll.rolls.length > 1 ? `[${roll.rolls.join(', ')}]=${roll.result}` : `[${roll.result}]`;
      const penaltyStr = exhaustionPenalty !== 0 ? ` (${exhaustionPenalty} exhaustion)` : '';
      const effectiveResult = Math.max(1, roll.result + exhaustionPenalty);
      return `${name} (stat ${stat}, ${typeLabel}): ${rollStr}${penaltyStr} = effective ${effectiveResult}`;
    };

    const rollsText = [
      formatRoll('MIGHT', stats.might, rolls.might),
      formatRoll('AGILITY', stats.agility, rolls.agility),
      formatRoll('MIND', stats.mind, rolls.mind),
      formatRoll('PRESENCE', stats.presence, rolls.presence)
    ].join('\n');

    const exhaustionNote = exhaustionPenalty !== 0
      ? `\n\nEXHAUSTION: Player has been awake ${exhaustionState.hoursAwake} hours. ${exhaustionDebuffs.level} state applies ${exhaustionPenalty} penalty to all rolls.`
      : '';

    // Build messages array with conversation history for context
    const messagesForLLM = [
      ...conversationHistory.slice(-MAX_HISTORY),
      { role: 'user', content: message }
    ];

    // Step 1: Chat LLM generates narrative response
    const chatSystemPrompt = `You are the Dungeon Master for a D&D-style RPG. You create an immersive, engaging narrative experience.

CURRENT WORLD STATE (from memory.md):
${memory}

PLAYER CHARACTER: ${stats.name}
STATS: MIGHT ${stats.might}, AGILITY ${stats.agility}, MIND ${stats.mind}, PRESENCE ${stats.presence}

DICE ROLLS (use these for any checks - do NOT make up your own numbers):
${rollsText}${exhaustionNote}

ROLL INTERPRETATION:
- 1: Critical failure (something goes very wrong)
- 2-6: Failure with consequences
- 7-10: Partial success or failure with silver lining
- 11-15: Success with minor complication
- 16-19: Clean success
- 20: Critical success (exceptional outcome, bonus effect)

WHEN TO USE ROLLS:
- Combat: AGILITY for attack accuracy, MIGHT for damage/force
- Physical challenges: MIGHT for strength, AGILITY for finesse
- Social encounters: PRESENCE for persuasion, intimidation, deception
- Investigation/puzzles: MIND for knowledge, perception, reasoning
- Only use rolls when outcome is uncertain. Trivial actions auto-succeed.

CONVERSATION HISTORY (recent exchanges for context):
${conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}

Your role:
- Respond to player actions in character
- When a roll is used, subtly weave the result into narrative (don't say "you rolled 15")
- Instead say things like "Your blade finds its mark" or "Despite your best efforts..."
- Be descriptive and engaging
- Leave room for player agency
- NEVER make assumptions about what the player wants - describe situations and let them choose
- IMPORTANT: Pay close attention to conversation history! Maintain continuity.

EXHAUSTION AWARENESS:
- If exhaustion debuffs are mentioned above, the player is fatigued - reflect this in descriptions
- Tired players might fumble, yawn, have blurred vision
- Exhausted players struggle with complex tasks, make mistakes
- If player tries to sleep/rest, describe the experience appropriately
- Bed quality affects rest: street = uncomfortable, noble = luxurious

Keep responses concise (2-3 paragraphs max). Focus on sensory details and player agency.`;

    const chatResponse = await callGLM(messagesForLLM, chatSystemPrompt);

    // Add to conversation history and persist
    conversationHistory.push({ role: 'user', content: message });
    conversationHistory.push({ role: 'assistant', content: chatResponse });

    // Trim history if needed and save to file
    if (conversationHistory.length > MAX_HISTORY) {
      conversationHistory = conversationHistory.slice(-MAX_HISTORY);
    }
    await saveConversationHistory();

    // Check if sleep was successful (DM described sleeping)
    let diaryEntry = null;
    let sleepOccurred = false;
    const sleepIndicators = ['sleep', 'slumber', 'rest', 'dreams', 'wake', 'morning comes', 'night passes', 'hours of sleep', 'drift off', 'close your eyes', 'bed', 'pillow', 'blanket', 'mattress'];
    const dmLower = chatResponse.toLowerCase();

    console.log('Sleep detection:', { isSleepAttempt, messageContainsSleep: sleepIndicators.some(ind => dmLower.includes(ind)) });

    if (isSleepAttempt && sleepIndicators.some(ind => dmLower.includes(ind))) {
      sleepOccurred = true;
      console.log('Sleep occurred! Generating diary entry...');

      // Detect bed quality and generate diary
      const bedQuality = detectBedQuality(message, chatResponse);
      const eventPool = parseEventPool(memory);

      // Generate diary entry
      diaryEntry = await generateDiaryEntry(memory, eventPool, characterVoice, exhaustionState, stats);
      console.log('Diary entry generated:', diaryEntry ? diaryEntry.substring(0, 100) + '...' : 'EMPTY');

      // Check if we need to update character voice (every 7 days)
      let newVoice = null;
      if (currentDay - characterVoice.lastUpdatedDay >= 7) {
        newVoice = await updateCharacterVoice(memory, stats, currentDay);
      }

      // Store sleep data for the world LLM to process
      memory = memory + `\n\n<!-- SLEEP_DATA: bedQuality=${bedQuality.name}, bonusHours=${bedQuality.bonusHours}, exhaustionFloor=${bedQuality.exhaustionFloor}, diaryEntry=${JSON.stringify(diaryEntry)}, newVoice=${JSON.stringify(newVoice)} -->`;
    }

    // DOUBLE-ENTRY ACCOUNTING: Detect and apply coin transactions
    const currentTime = parseCurrentTime(memory);
    const coinTransactions = detectCoinTransactions(chatResponse, message);
    if (coinTransactions.length > 0) {
      console.log('Detected coin transactions:', coinTransactions);
      memory = applyTransactionsToMemory(memory, coinTransactions, currentDay, currentTime);
    }

    // Step 2: World LLM updates memory based on what happened
    const worldSystemPrompt = `You are the World Builder - you maintain the persistent state of the game world.

CURRENT MEMORY:
${memory}

PLAYER'S ACTION: ${message}

DM'S RESPONSE: ${chatResponse}

Your task: Update memory.md to reflect any changes that occurred.

CRITICAL RULES FOR TIME TRACKING:
- ALWAYS update WORLD_TIME section - track day count and time of day progression
- Time flows naturally: Morning → Midday → Afternoon → Evening → Night → (next day) Morning
- Increment day count ONLY when transitioning from Night to Morning
- Look for time indicators in the DM's response: "hours pass", "night falls", "dawn breaks", etc.
- If DM says "you rest" or "you sleep until morning", advance time appropriately
- If memory doesn't have WORLD_TIME section yet, create it at the top

EXHAUSTION SYSTEM - CRITICAL:
- Track hours awake in ## 😴 EXHAUSTION section
- Each time period transition = approximately 4 hours (Morning→Midday = 4 hours, etc.)
- Format:
  ## 😴 EXHAUSTION
  **Hours Awake:** [number]
  **Last Slept Day:** [day number]
  **Last Slept Time:** [time of day]
  **Exhaustion Level:** [Rested/Tired/Exhausted/Severely Exhausted]
  **Bed Bonus Hours:** [number, can be negative]
  **Last Updated:** Day X, TimeOfDay

- Exhaustion thresholds:
  - 0-13 hours: Rested (no penalties)
  - 14-19 hours: Tired (-1 to all rolls)
  - 20-27 hours: Exhausted (-2 to all rolls)
  - 28-35 hours: Severely Exhausted (-3 to all rolls)
  - 36+ hours: Unconscious (handled separately)

- When player SLEEPS (check for SLEEP_DATA comment):
  - Reset Hours Awake to 0
  - Update Last Slept Day/Time to current
  - Apply bed quality effects (exhaustionFloor = minimum tiredness on wake, bonusHours = extra hours before exhaustion starts)
  - Set Exhaustion Level based on bed quality:
    - Noble bed: "Energized" (bonus +2 hours)
    - Street sleeping: "Tired" (floor of 4 hours fatigue)
  - CLEAR the EVENT_POOL section (new day cycle)
  - ADD the diary entry to ## 📖 DIARY section
  - If newVoice is provided, update ## 🎭 CHARACTER_VOICE section

EVENT POOL TRACKING:
- Maintain ## 📝 EVENT_POOL section to track significant events since last sleep
- Add brief summaries of: combat, conversations, discoveries, transactions, emotional moments
- Format:
  ## 📝 EVENT_POOL
  **Events:**
  - [Day X - Time] Brief description of event
  - [Day X - Time] Another event
  **Last Updated:** Day X, TimeOfDay

- On sleep, this pool is CLEARED (moved to diary)

DIARY SYSTEM (when SLEEP_DATA comment present):
- Add entry to ## 📖 DIARY section
- Format:
  ## 📖 DIARY
  **Last Updated:** Day X, TimeOfDay

  ### Day [X] - [Location]
  [diary entry text from SLEEP_DATA]

  ### Day [X-1] - [Previous Location]
  [previous entry]

CHARACTER_VOICE SECTION (when newVoice in SLEEP_DATA):
- Update or create ## 🎭 CHARACTER_VOICE section:
  ## 🎭 CHARACTER_VOICE
  **Core Tone:** [description]
  **Last Updated Day:** [day number]
  **Significant Memories:**
  - [memory]
  **Values:**
  - [value]

⚠️ COIN SECTIONS - ABSOLUTELY DO NOT TOUCH ⚠️
- COPY the ## 💰 COIN_PURSE section EXACTLY as it appears in the input - do not change ANY values
- COPY the ## 💰 COIN_LEDGER section EXACTLY as it appears in the input - do not change ANY values
- The accounting system handles all coin updates programmatically
- If you modify coin values, the game breaks
- Just preserve these sections byte-for-byte in your output

CRITICAL RULES FOR GENERAL_FACTS (RUMORS & LORE):
- NEVER include date/time information in GENERAL_FACTS section
- When adding a new rumor/fact, ALWAYS prepend it with the current in-game date in format: "[Day X - TimeOfDay]"
- Example: "[Day 3 - Evening] The innkeeper mentioned strange lights in the forest"
- The date stamp helps track WHEN the player learned each piece of information
- Do NOT update GENERAL_FACTS with time progression - only with actual new information

PLAYER STATE TRACKING:
- Update PLAYER_STATE section to reflect the player's physical and mental condition
- Condition levels: Healthy → Tired → Exhausted → Wounded → Critical
- Track fatigue naturally: extended activity without rest → Tired → Exhausted
- Rest/sleep restores condition (Exhausted → Tired → Healthy)
- Injuries from combat or accidents → Wounded (can stack with fatigue)
- Note: This is qualitative, not HP. Use narrative judgment.

OTHER RULES:
- NEVER modify PLAYER_STATS section - this is set during character creation and is immutable
- Always include WORLD_TIME section at the top with current day and time (below header)
- Always update PLAYER_STATE when condition changes (fatigue, injury, rest)
- Add to GENERAL_FACTS when player learns rumors, world lore, or important information
- Only update sections that actually changed
- Maintain the EXACT format of each section
- Keep ALL entries - NEVER delete old entries, always preserve the complete history
- Add NEW entries at the top of each section with date/time stamps
- For EVERY new entry, prepend with "[Day X - TimeOfDay]" to show when it happened
- For COIN_PURSE: add transaction entries like "[Day 3 - Evening] Paid 2 coins for ale"
- For INVENTORY: add entries like "[Day 2 - Morning] Found rusty sword"
- For LOCATIONS: add entries like "[Day 1 - Afternoon] Discovered village"
- For PEOPLE_MET: add entries like "[Day 4 - Noon] Met Elara the merchant"
- For GENERAL_FACTS: add entries like "[Day 2 - Evening] Heard rumor about dragon in mountains"
- For PLAYER_STATE: add condition changes like "[Day 2 - Night] Exhausted from travel"
- REMOVE any <!-- SLEEP_DATA: ... --> comments from the output

Return ONLY the updated memory.md content. No explanations, no markdown code blocks - just the raw content.`;

    const worldResponse = await callGLM(
      [{ role: 'user', content: `Process this action and update memory.` }],
      worldSystemPrompt
    );

    // Clean the response (remove markdown code blocks if present)
    let updatedMemory = worldResponse.trim();
    if (updatedMemory.startsWith('```')) {
      updatedMemory = updatedMemory.split('\n').slice(1, -1).join('\n');
    }

    // SAFETY: Preserve coin sections from the pre-processed memory (with our ledger updates)
    // The LLM sometimes zeros these out despite instructions
    const preserveCoinPurse = memory.match(/## 💰 COIN_PURSE[\s\S]*?(?=---|\n## [^💰])/);
    const preserveCoinLedger = memory.match(/## 💰 COIN_LEDGER[\s\S]*?(?=---|\n## [^💰])/);

    if (preserveCoinPurse) {
      updatedMemory = updatedMemory.replace(
        /## 💰 COIN_PURSE[\s\S]*?(?=---|\n## [^💰])/,
        preserveCoinPurse[0]
      );
    }
    if (preserveCoinLedger) {
      updatedMemory = updatedMemory.replace(
        /## 💰 COIN_LEDGER[\s\S]*?(?=---|\n## [^💰])/,
        preserveCoinLedger[0]
      );
    }

    // Write updated memory
    await writeMemory(updatedMemory);

    // Include exhaustion info and diary entry in response
    const responseData = {
      response: chatResponse,
      memoryUpdated: true,
      rolls: rolls,
      stats: stats,
      exhaustion: {
        hoursAwake: exhaustionState.hoursAwake,
        level: exhaustionDebuffs.level,
        debuffs: exhaustionDebuffs.debuffs
      }
    };

    // Add diary entry if sleep occurred
    if (sleepOccurred && diaryEntry) {
      responseData.diaryEntry = diaryEntry;
      responseData.sleepOccurred = true;
    }

    res.json(responseData);

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: 'Failed to process chat', details: error.message });
  }
});

// API: Check if character exists
app.get('/api/character', async (req, res) => {
  try {
    const memory = await readMemory();
    const stats = parsePlayerStats(memory);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to check character' });
  }
});

// API: Create character
app.post('/api/character', async (req, res) => {
  try {
    const { name } = req.body;
    // Ensure stats are integers
    const might = parseInt(req.body.might) || 2;
    const agility = parseInt(req.body.agility) || 2;
    const mind = parseInt(req.body.mind) || 2;
    const presence = parseInt(req.body.presence) || 2;

    // Validate stats (must sum to 8, each between 1-3)
    const total = might + agility + mind + presence;
    if (total !== 8) {
      return res.status(400).json({ error: 'Stats must sum to 8' });
    }
    if ([might, agility, mind, presence].some(s => s < 1 || s > 3)) {
      return res.status(400).json({ error: 'Each stat must be between 1 and 3' });
    }

    const memory = await readMemory();

    // Create PLAYER_STATS section
    const statsSection = `## 🎭 PLAYER_STATS
**Name:** ${name || 'Adventurer'}
**MIGHT:** ${might}
**AGILITY:** ${agility}
**MIND:** ${mind}
**PRESENCE:** ${presence}

**Stat Effects:**
- MIGHT ${might}: ${might >= 3 ? 'Advantage' : might <= 1 ? 'Disadvantage' : 'Normal'} on physical power, melee damage, endurance
- AGILITY ${agility}: ${agility >= 3 ? 'Advantage' : agility <= 1 ? 'Disadvantage' : 'Normal'} on attack accuracy, dodging, stealth
- MIND ${mind}: ${mind >= 3 ? 'Advantage' : mind <= 1 ? 'Disadvantage' : 'Normal'} on knowledge, perception, puzzles
- PRESENCE ${presence}: ${presence >= 3 ? 'Advantage' : presence <= 1 ? 'Disadvantage' : 'Normal'} on social, persuasion, intimidation

---

`;

    // Insert before PLAYER_STATE section (after WORLD_TIME)
    const insertPoint = memory.indexOf('## 🧍 PLAYER_STATE');
    let updatedMemory;

    if (insertPoint !== -1) {
      // Insert before PLAYER_STATE
      updatedMemory = memory.slice(0, insertPoint) + statsSection + memory.slice(insertPoint);
    } else {
      // Fallback: find the second --- (after WORLD_TIME section)
      const firstDivider = memory.indexOf('---');
      const secondDivider = memory.indexOf('---', firstDivider + 3);
      if (secondDivider !== -1) {
        // Insert after the second divider
        const insertAt = memory.indexOf('\n', secondDivider) + 1;
        updatedMemory = memory.slice(0, insertAt) + '\n' + statsSection + memory.slice(insertAt);
      } else {
        // Last resort: append after first divider block
        const afterFirstBlock = memory.indexOf('\n\n', firstDivider) + 2;
        updatedMemory = memory.slice(0, afterFirstBlock) + statsSection + memory.slice(afterFirstBlock);
      }
    }

    await writeMemory(updatedMemory);

    res.json({ success: true, stats: { name, might, agility, mind, presence, exists: true } });
  } catch (error) {
    console.error('Character creation error:', error.message, error.stack);
    res.status(500).json({ error: 'Failed to create character: ' + error.message });
  }
});

// API: Get current memory (for Adventure Journal)
app.get('/api/memory', async (req, res) => {
  try {
    const memory = await readMemory();
    res.json({ memory });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read memory' });
  }
});

// API: Export save (memory + conversation history)
app.get('/api/export', async (req, res) => {
  try {
    const memory = await readMemory();
    const saveData = {
      exportedAt: new Date().toISOString(),
      version: '1.0',
      memory: memory,
      conversationHistory: conversationHistory
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="rpg-save-${Date.now()}.json"`);
    res.json(saveData);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ error: 'Failed to export save' });
  }
});

// API: Import save
app.post('/api/import', async (req, res) => {
  try {
    const { memory, conversationHistory: importedHistory } = req.body;

    if (!memory) {
      return res.status(400).json({ error: 'Invalid save file: missing memory' });
    }

    await writeMemory(memory);

    if (importedHistory && Array.isArray(importedHistory)) {
      conversationHistory = importedHistory;
      await saveConversationHistory();
    }

    res.json({ success: true, message: 'Save imported successfully' });
  } catch (error) {
    console.error('Import error:', error);
    res.status(500).json({ error: 'Failed to import save' });
  }
});

// API: Reset adventure (clear all memory and conversation history)
app.post('/api/reset', async (req, res) => {
  try {
    const fantasyDate = generateFantasyDate();

    // Reset memory.md to initial state with fantasy date and new sections
    const initialMemory = `# WORLD_MEMORY_VERSION: 2
# FORMAT: structured_markdown
# LAST_MIGRATION: none
# CREATED: ${new Date().toISOString().split('T')[0]}
# WORLD_STATE: INITIALIZING
# FANTASY_DATE_LOCKED: ${fantasyDate}

---

# 🕐 WORLD_TIME
**Fantasy Date:** ${fantasyDate}
**Day Count:** 1
**Time of Day:** Morning
**Season:** Spring
**Last Updated:** Real: ${new Date().toISOString().split('T')[0]}

**Time Tracking:**
- Days elapsed: 1
- Time progression: Morning of day 1
- Notes: World time begins now.

---

## 🧍 PLAYER_STATE
**Condition:** Healthy
**Last Updated:** Day 1, Morning

**Status Log:**
- [Day 1 - Morning] Starting condition: Well-rested and ready for adventure

---

## 😴 EXHAUSTION
**Hours Awake:** 0
**Last Slept Day:** 1
**Last Slept Time:** Morning
**Exhaustion Level:** Rested
**Bed Bonus Hours:** 0
**Last Updated:** Day 1, Morning

---

## 📝 EVENT_POOL
**Events:**
- [Day 1 - Morning] Adventure begins at the crossroads
**Last Updated:** Day 1, Morning

---

## 📖 DIARY
**Last Updated:** Day 1, Morning

*No entries yet. Your story is just beginning...*

---

## 🎭 CHARACTER_VOICE
**Core Tone:** Not yet established
**Last Updated Day:** 0
**Significant Memories:**
- None yet
**Values:**
- None yet

---

## 💰 COIN_PURSE
**Platinum (pp):** 0
**Gold (gp):** 1
**Silver (sp):** 5
**Copper (cp):** 0
**Last Updated:** Day 1, Morning

**Conversion:** 10 cp = 1 sp, 10 sp = 1 gp, 10 gp = 1 pp

---

## 💰 COIN_LEDGER
**Balance PP:** 0
**Balance GP:** 1
**Balance SP:** 5
**Balance CP:** 0
**Total Value:** 150 copper

| ID | Date | Description | Debit | Credit |
|----|------|-------------|-------|--------|
| 1 | Day 1 - Morning | Starting funds | - | 1gp 5sp |

*Note: Balance is authoritative. UI reads from Balance fields above.*

---

## ⚔️ INVENTORY
**Last Updated:** Day 1, Morning

**Items:**
- [v1] Traveler's Clothes (starting gear)
- [v1] Small Knife (starting gear)

---

## 📍 LOCATIONS_VISITED
**Last Updated:** Day 1, Morning

**Locations:**
- [v1] Starting Point - You stand at a crossroads. Paths lead north, south, east, and west. The morning sun casts long shadows across the dirt road.

---

## 👥 PEOPLE_MET
**Last Updated:** Day 1, Morning

**People:**
- None yet. Your adventure begins...

---

## 📜 GENERAL_FACTS
**Last Updated:** Day 1, Morning

**Facts & Rumors Learned:**
- None yet. As you explore, you'll learn about the world - its history, its secrets, and its stories.
`;

    await writeMemory(initialMemory);

    // Clear conversation history and persist
    conversationHistory = [];
    await saveConversationHistory();

    res.json({ success: true, message: 'Adventure reset successfully' });
  } catch (error) {
    console.error('Reset error:', error);
    res.status(500).json({ error: 'Failed to reset adventure' });
  }
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  🎮 LLM-SQL-RPG Server Running                          ║
║                                                         ║
║  Chat: http://localhost:${PORT}                           ║
║  API:  http://localhost:${PORT}/api/chat                  ║
║                                                         ║
║  Press Ctrl+C to stop                                   ║
╚══════════════════════════════════════════════════════════╝
  `);
});
