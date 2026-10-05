# MMA Timekeeper

A round clock and a time-out / rest clock for MMA timekeepers. Plain web code. It works in any browser on iPhone, iPad, Android, Mac and PC.

## Files

| File | What it is |
|---|---|
| `index.html` | The screen: clocks, buttons, Settings and Adjust panels |
| `style.css` | Colors, sizes and layout. Colors are listed at the top. |
| `timer.js` | How it works: timing, warnings, sounds, keep-screen-on |
| `manifest.json` | Name and icon for "Add to Home Screen" |
| `sw.js` | Offline helper: lets the timer open with no internet |
| `icons/` | App icons |
| `vendor/keepawake-media.js` | Tiny silent video, the backup method for keeping the screen on (from NoSleep.js, MIT License) |

## Try it on your Mac

Double-click `index.html`. It opens in your browser.

## Publish (GitHub + Vercel)

1. Create a new GitHub repository and push this folder to it.
2. In Vercel, choose **Add New → Project** and import that repository.
3. Framework preset: **Other**. Leave the build command empty. Click **Deploy**.

## After every update

Open `sw.js` and change `VERSION` (for example `mmatk-v1` to `mmatk-v2`). This makes devices load the new files.

## How the timing works

Timestamp-based. The app notes the exact start moment from the device's forward-only clock and subtracts on every screen refresh. It never counts ticks, so it can't drift.
