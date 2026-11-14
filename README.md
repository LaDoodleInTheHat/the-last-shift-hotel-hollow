# THE LAST SHIFT: Hotel Hollow

A first-person 3D horror game for the browser. It's 3:17 AM, you're the night porter, the front
doors have vanished and the staff never left. Solo or up to 4-player co-op with proximity voice chat.

Everything is procedural: textures are painted on `<canvas>`, audio is synthesised with the Web
Audio API, and the hotel is generated from a seed (same seed, same hotel).

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000. The server reads `process.env.PORT` (default 3000).

`npm test` runs a smoke test of the hotel generator over 300 seeds.

## Deploy to Render

The repo includes a `render.yaml` Blueprint (one free-tier Node web service).

1. Push this repo to GitHub.
2. In the Render dashboard choose **New > Blueprint** and pick the repo, or open
   `https://dashboard.render.com/blueprint/new?repo=<your repo URL>`.
3. Render runs `npm install`, then `npm start`. The health check is `/healthz`.

Free instances sleep when idle, so the first visit after a while takes a moment to wake.

## How to play

Find 5 master keycards hidden in guest rooms. The fifth unlocks the elevator and summons the
Manager. Reach the elevator to clock out. Being caught by any member of staff ends your shift.

The map in the top-right corner starts empty and fills in as you explore. Keycards are always
marked on it (and the elevator, once it unlocks); the staff never are. Short red warnings appear
when something is close.

| Key | Action |
| --- | --- |
| WASD / mouse | Move / look (arrow keys also turn) |
| Shift | Sprint (loud, uses stamina) |
| C | Crouch (silent) |
| F | Flashlight (drains about 1% per second) |
| E | Hide in / climb out of a wardrobe |
| Click or R | Fire a signal rocket (stuns staff in the blast) |
| V | Mute / unmute microphone (co-op) |
| Esc | Pause (solo only: co-op does not pause) |

### The staff

- **The Concierge** always walks toward the nearest porter. His service bell rings faster and louder as he closes in.
- **The Maid** moves fast only while nobody is looking at her. Seen, she freezes and covers her face. When the weeping stops, she is coming.
- **The Bellhop** crawls on patrol and hunts by sound: sprinting, rockets and your voice chat all attract him. He charges on sight, then has to rest.
- **The Manager** arrives after the fifth keycard, knows where everyone is (wardrobes included) and shrugs off rockets quickly.

### Co-op, voice and spectating

- One player opens a shift and shares the 4-letter code. Keycards are shared by the team.
- Voice is positioned in 3D: it fades over about 25 m and is muffled through walls. Use headphones. The game asks for your microphone when you join a shift; press V in game to mute or unmute.
- Voice connects peer-to-peer (WebRTC) where it can. If two players cannot reach each other directly, that pair automatically falls back to relaying audio through the game server, so voice works wherever the game does. The lobby shows which one each player is using. Append `?relay` to the URL to force the relay path for testing.
- Optional: set an `ICE_SERVERS` environment variable (a JSON array of WebRTC ICE servers, for example a TURN service) to give the peer-to-peer path more ways through.
- When you die you become a spectator: a free-flying camera with full lighting, beacons on every porter and monster, and a live map (Tab jumps between targets, M enlarges the map). The dead can talk to each other; the living cannot hear them.
- The host's browser simulates the monsters. If the host leaves, another player takes over.

## Project layout

```
server.js            Express static server + WebSocket relay (rooms, seed, host migration)
render.yaml          Render Blueprint
public/index.html    Page, HUD and menus
public/css/style.css
public/js/maze.js      Seeded generation (mulberry32), A*, BFS, line of sight
public/js/textures.js  Procedural canvas textures and monster faces
public/js/render.js    Three.js scene, lights, doors, post-processing, spectator view
public/js/monsters.js  Monster models and AI
public/js/audio.js     Synthesised audio
public/js/net.js       WebSocket client
public/js/voice.js     Proximity voice chat (WebRTC)
public/js/ui.js        Menus, HUD, jumpscare, spectator map
public/js/main.js      Game loop, player controller, co-op glue
test/smoke.mjs         Generator smoke test
```
