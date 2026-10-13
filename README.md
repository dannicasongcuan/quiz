# Live Quiz – speed-scored quizzes for training and events

A lightweight Slido/Menti-style quiz. Participants join on their phone or laptop and answer on their device. The host screen (which you share in Teams or put on the room screen) shows the live timer, the answers, the fastest correct responders, and the leaderboard.

## What it tracks
- **Correct answers**: each correct answer earns 500 base points.
- **Speed**: each correct answer also earns up to 500 bonus points. The faster the answer, the bigger the bonus. Wrong answers score 0, however fast they are.
- **Fastest per question**: each question shows the top 5 fastest correct answers, timed to 0.01s.
- **Fastest-finger wins**: a count of how many questions each person was first to answer correctly.
- **Final awards**: fastest single answer, most fastest-finger wins, and quickest average time.
- **Exports**: you can download two CSV files that open in Excel:
  - **Responses**: every person, every question, their answer, correct or not, response time, speed rank and points.
  - **Leaderboard**: final rank, score, number correct, fastest-finger wins, average time and fastest time.

## Setup (one time)
1. Install **Node.js 18 or later** (LTS) from nodejs.org. You don't need to install anything else.
2. Unzip this folder.

## Run a quiz
1. Edit `questions.json` (see below).
2. Open a terminal in the folder and run:
   - Windows (PowerShell): `$env:HOST_KEY="yoursecret"; node server.js`
   - Mac: `HOST_KEY=yoursecret node server.js`
3. Open **http://localhost:3000/host** and enter your host key.
4. Share that screen. Participants scan the QR code or type the join link.
5. Click **Start quiz ▶**. After each question, click **Reveal answer**, then **Show leaderboard** or **Next question ▶**.
6. **Download both CSVs before you stop the server or click Reset.** Results are only held in memory while the server runs.

## Editing questions (`questions.json`)
```json
{
  "text": "Your question?",
  "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
  "correct": 2,
  "seconds": 15
}
```
- `correct` is the **option number**, so 1 means the first option.
- Each question needs 2 to 6 options.
- `seconds` is optional. If you leave it out, the question uses `secondsPerQuestion` from `settings`.
- `settings` sets the points and whether the answer is revealed automatically once everyone has answered.
- After you edit the file, click **Reset** on the host screen (or restart the server) to load the changes.

## Who can join
| Situation | What to do |
|---|---|
| **In the office** | Participants need to be on the same network as the laptop running the quiz. The host screen shows the join link automatically. If the guest Wi-Fi blocks this, use the hosted option below. |
| **Online / hybrid** | The quiz needs a link people can open from anywhere. Ask IT to host it, for example on Azure App Service (it's a single Node app). Or use an approved tunnel such as Microsoft Dev Tunnels. Start the server with `PUBLIC_URL=https://your-link` so the QR code points to the right address. |

## Good to know
- If a participant refreshes or loses connection, they rejoin automatically on the same device and keep their score.
- If two people use the same name, the second becomes "Name (2)".
- The server records response times when answers arrive. A slow connection can add a fraction of a second, which is fine for a friendly competition.
- The QR code loads from a public CDN (cdnjs). If that's blocked, the join link still shows.
- People can join partway through. They just won't have points for the questions they missed.
