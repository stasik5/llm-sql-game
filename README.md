# LLM-SQL-RPG - Generative Text RPG with Persistent World Memory

## Overview

A text-based D&D-style RPG where two LLMs work together to create a persistent, evolving world:
- **Chat LLM** (Dungeon Master) - Generates narrative responses and roleplays NPCs
- **World LLM** (World Builder) - Maintains persistent state in `memory.md` with reasoning logs

The world builds itself around the player as they explore - locations, NPCs, items, and lore are dynamically created and remembered.

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Vanilla HTML/CSS/JavaScript
- **LLM API:** GLM-5 via z.ai proxy (Anthropic-compatible)
- **Storage:** `memory.md` file (structured markdown with version history)

## Architecture

### Dual-LLM System

```
Player Input → Chat LLM → Narrative Response
              ↓
         World LLM → Update memory.md
```

**Per-Request Flow:**
1. Player types action
2. Chat LLM receives: current memory.md + conversation history (last 200 messages) + player action
3. Chat LLM generates narrative response
4. World LLM receives: current memory.md + player action + DM response
5. World LLM updates memory.md with reasoning and date/time stamps
6. UI updates with new state

### Memory Format (`memory.md`)

```markdown
# WORLD_MEMORY_VERSION: 2
# FORMAT: structured_markdown
# LAST_MIGRATION: none
# CREATED: 2025-02-25
# WORLD_STATE: INITIALIZING
# FANTASY_DATE_LOCKED: 12 Primember, 347 of the Age of Wonder

---

# 🕐 WORLD_TIME
**Fantasy Date:** 12 Primember, 347 of the Age of Wonder
**Day Count:** 1
**Time of Day:** Morning
**Season:** Spring
**Last Updated:** Real: 2025-02-25

**Time Tracking:**
- Days elapsed: 1
- Time progression: Morning of day 1
- Notes: World time begins now.

---

## 💰 COIN_PURSE
**Current:** 10 coins
**Last Updated:** Day 1, Morning

**Transaction History:**
- [Day 1 - Morning] Starting amount → 10 coins
- [Day 1 - Afternoon] Purchased ale at tavern → -2 coins → 8 coins
- [Day 1 - Evening] Sold old rope → +1 coin → 9 coins

---

## ⚔️ INVENTORY
**Last Updated:** Day 1, Morning

**Items:**
- [Day 1 - Morning] Traveler's Clothes (starting gear)
- [Day 1 - Morning] Small Knife (starting gear)
- [Day 2 - Evening] Rusty Sword (found in cellar)

---

## 📍 LOCATIONS_VISITED
**Last Updated:** Day 1, Morning

**Locations:**
- [Day 1 - Morning] Starting Point - Crossroads at dawn
- [Day 1 - Afternoon] Oakhaven - Village in the valley
- [Day 1 - Evening] The Rusty Anchor Inn - Smells of ale and roasting garlic

---

## 👥 PEOPLE_MET
**Last Updated:** Day 1, Morning

**People:**
- [Day 1 - Afternoon] Barnaby (Innkeeper) - Stout, balding man with thick mustache
- [Day 1 - Evening] Mysterious Stranger - Hooded figure in the corner

---

## 📜 GENERAL_FACTS
**Last Updated:** Day 1, Morning

**Facts & Rumors Learned:**
- [Day 1 - Afternoon] Barnaby mentioned: "Strange lights seen in the Old Forest lately"
- [Day 2 - Morning] Town guard warned: "Don't travel the roads at night, bandits about"
- [Day 2 - Evening] Overheard rumor: "The old king's treasure was never found"
```

### Key Design Decisions

1. **Version History with Reasoning**
   - Every change includes: `[Day X - TimeOfDay]` stamp + reasoning
   - Full history preserved (no automatic deletion)
   - Enables debugging and "undo" capability

2. **Conversation Context**
   - Last 200 message exchanges sent to Chat LLM
   - Prevents "forgot what just happened" issues
   - ~50k token budget utilized

3. **Time System**
   - Fantasy date generated once at world creation, then locked
   - Time flows: Morning → Midday → Afternoon → Evening → Night → Morning (next day)
   - Day count increments on Night → Morning transition
   - Every entry in journal includes date/time stamp

4. **Transaction Safety**
   - World LLM instructed to only deduct coins for actual completed transactions
   - Price mentions, negotiations don't trigger deductions
   - Prevents double-charging

## File Structure

```
llm-sql-rpg/
├── server.js              # Express server with LLM integrations
├── memory.md               # Persistent world state (structured markdown)
├── .env                    # API keys (gitignored)
├── package.json            # Dependencies
├── .gitignore             # Excludes .env, node_modules/
└── public/
    └── index.html         # Chat UI + Adventure Journal
```

## API Endpoints

### POST /api/chat
Processes a player action and returns the DM's response.

**Request:**
```json
{
  "message": "I head to the tavern"
}
```

**Response:**
```json
{
  "response": "You push open the heavy oak door...",
  "memoryUpdated": true
}
```

### GET /api/memory
Returns the current memory.md content.

**Response:**
```json
{
  "memory": "# 🕐 WORLD_TIME\n**Fantasy Date:** ..."
}
```

### POST /api/reset
Resets the adventure to initial state. Generates new fantasy date, clears all progress.

**Response:**
```json
{
  "success": true,
  "message": "Adventure reset successfully"
}
```

## Configuration

### Environment Variables (.env)

```env
GLM_API_KEY=your_api_key_here
GLM_API_URL=https://api.z.ai/api/anthropic
PORT=3000
```

### Model Mapping (z.ai proxy)

- `claude-3-5-opus-20241022` → `glm-5`
- `claude-3-5-sonnet-20241022` → `glm-4.7`
- `claude-3-5-haiku-20241022` → `glm-4.5-air`

## Features

### Player Interface
- **Chat panel** - Conversation with DM
- **World Time panel** - Fantasy date, time of day
- **Coin display** - Current gold pieces
- **Inventory panel** - List of owned items
- **Adventure Journal** (📖 button) - Full world memory
- **Reset button** - Start fresh adventure

### Adventure Journal Sections
1. **🕐 World Time** - Current date and time tracking
2. **💰 Coin Purse** - Transaction history with reasoning
3. **⚔️ Inventory** - Items with acquisition details
4. **📍 Locations** - Places discovered with descriptions
5. **👥 People** - NPCs met with characteristics
6. **📜 General Facts** - Rumors, lore, world information

All entries include date/time stamps: `[Day X - TimeOfDay]`

### Time Progression
World LLM automatically advances time based on narrative:
- "hours pass" → advance time of day
- "you rest until morning" → advance to next day
- "night falls" → transition to evening/night

## Installation & Running

```bash
# Install dependencies
npm install

# Configure API keys in .env
# GLM_API_KEY=your_key
# GLM_API_URL=https://api.z.ai/api/anthropic

# Start server
npm start
```

Server runs on http://localhost:3000

## World LLM Prompt Guidelines

### Time Tracking
- Always update WORLD_TIME section
- Time flows naturally through the day
- Increment day count only on Night → Morning

### Coin Transactions
- ONLY deduct for actual completed payments
- Negotiations/mentions don't count
- When uncertain, don't deduct

### General Facts (Rumors & Lore)
- NEVER include time progression in facts
- Always add date stamp: `[Day X - TimeOfDay]`
- Include the current in-game date with each new rumor

### Entry Format
- Prepend ALL entries with: `[Day X - TimeOfDay]`
- Keep complete history (no automatic deletion)
- Add reasoning for every change

## Future Enhancements (Ideas)

- [ ] SQL database for better querying
- [ ] Save/load multiple adventures
- [ ] Combat system with dice rolls
- [ ] Quest tracking
- [ ] Skill/level progression
- [ ] Multiple save slots
- [ ] Export adventure as readable story
- [ ] Import custom world settings

## Technical Notes

- **Context Window:** 200 message exchanges (~50k tokens) for Chat LLM
- **Response Size:** Up to 4000 tokens per response
- **Model:** GLM-5 (via Anthropic API format)
- **State Persistence:** File-based (memory.md)
- **Conversation History:** In-memory, resets on server restart

## Credits

Built by Stan with BMAD agent collaboration.
Concept: D&D-style RPG where the world builds itself around the player.
