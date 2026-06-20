# Purple Pickaxe

**Automatically collect Twitch Channel Points and claim Twitch Drops.**

Purple Pickaxe is a lightweight, privacy-focused Chrome extension that helps Twitch viewers keep up with Channel Points and Drops without constantly monitoring their browser.

---

## Features

✅ Automatic Channel Point collection

✅ Automatic Twitch Drop claiming

✅ Twitch Drop progress tracking

✅ Session statistics and activity tracking

✅ Lightweight Manifest V3 architecture

✅ Local-first data storage

✅ No advertisements

✅ No trackers

✅ No sale of personal information

---

## How It Works

Purple Pickaxe monitors your active Twitch session and:

1. Detects when you are logged into Twitch.
2. Automatically collects Channel Points when they become available.
3. Tracks active Twitch Drop campaigns.
4. Claims completed Drops automatically.
5. Stores settings and statistics locally on your device.

All processing occurs locally within the extension.

---

## Permissions Explained

### `storage`

Used to save:

* User preferences
* Statistics
* Extension settings

### `tabs`

Used to:

* Detect Twitch tabs
* Monitor active Twitch pages
* Open or focus the Twitch Drops Inventory page when required

### `cookies`

Used only to determine whether the user is currently logged into Twitch.

Purple Pickaxe does **not** collect, store externally, transmit, or sell authentication credentials.

### Host Permissions

#### `https://www.twitch.tv/*`

Required to:

* Monitor Twitch pages
* Detect Channel Point opportunities
* Track Drop progress

#### `https://gql.twitch.tv/*`

Required to:

* Communicate with Twitch's GraphQL API
* Read Drop progress
* Claim Drops

---

## Privacy

Purple Pickaxe is designed to be privacy-first.

* No advertisements
* No analytics
* No telemetry
* No third-party tracking
* No external servers
* No sale of personal information

All processing occurs locally on your device.

---

## Installation

### Chrome Web Store

Coming soon.

### Developer Installation

1. Clone the repository:

```bash
git clone https://github.com/YOUR_USERNAME/purple-pickaxe.git
```

2. Open:

```text
chrome://extensions
```

3. Enable **Developer Mode**.

4. Click **Load unpacked**.

5. Select the `purple-pickaxe` folder.

---

## Building

No build process is required.

The extension runs directly from the source files.

---

## Project Structure

```text
purple-pickaxe/
├── manifest.json
├── background.js
├── content.js
├── popup.html
├── popup.js
├── popup.css
├── images/
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   └── icon-128.png
└── README.md
```

---

## Roadmap

* [ ] Improved statistics dashboard
* [ ] Twitch campaign calendar
* [ ] Notifications and reminders
* [ ] Historical Drop tracking
* [ ] Optional cloud sync
* [ ] Multi-account dashboard

---

## Contributing

Issues, suggestions, and pull requests are welcome.

If Purple Pickaxe saves you time and you would like to support development, consider sponsoring the project or buying me a coffee.

---

## Disclaimer

Purple Pickaxe is an independent project and is **not affiliated with, endorsed by, or sponsored by Twitch Interactive, Inc.** Twitch is a trademark of Twitch Interactive, Inc.
