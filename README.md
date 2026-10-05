# TOILET.IO - Multiplayer Toilet Battle Game

A fun multiplayer .io game where you play as a toilet battling other toilets!

## Features

- **Multiplayer Support**: Real-time multiplayer with WebSocket
- **Bot AI**: Smart bots with different skill levels (Noob, Pro, SuperPro)
- **Custom Skins**: Choose from 6 different toilet colors
- **Upgrades**: Level up and upgrade your abilities
- **Combat**: Shoot piss, charge attacks, and use mega poop
- **Leaderboard**: Compete for the top spot

## How to Play

1. Enter your toilet name
2. Choose your skin color
3. Click "PLAY" to start
4. Use WASD to move, mouse to aim, click to shoot
5. Collect poop to level up
6. Defeat other toilets to climb the leaderboard!

## Controls

- **WASD**: Move
- **Mouse**: Aim
- **Left Click**: Shoot
- **Space**: Dash
- **Right Click / E**: Charge attack
- **Q**: Use mega poop (when charged)

## Tech Stack

- **Frontend**: Pure HTML5 Canvas + JavaScript
- **Backend**: Node.js + WebSocket
- **Hosting**: Render

## Development

### Prerequisites
- Node.js 16+

### Local Development

```bash
# Install dependencies
npm install

# Start the server
npm start
```

The game will be available at `http://localhost:3000`

## Deployment

This project is configured for Render deployment with the following settings:

- **Build Command**: `npm install`
- **Start Command**: `node server.js`
- **Port**: 10000

## Credits

Original game concept and implementation.

## License

MIT
