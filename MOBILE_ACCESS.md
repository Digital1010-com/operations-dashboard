# Operations Dashboard - Mobile Access Guide

**Dashboard URL (Desktop):** http://127.0.0.1:3200  
**Last Updated:** 2026-02-12

---

## Option 1: Same Network Access (Easiest)

If your phone and Mac are on the same WiFi network:

### Step 1: Find Your Mac's Local IP

Your Mac's current IP: **192.168.1.23**

### Step 2: Access from Mobile

On your phone's browser, go to:

**http://192.168.1.23:3200**

### Troubleshooting

**"Can't connect":**
1. Verify both devices on same WiFi
2. Check Mac firewall isn't blocking port 3200:
   ```bash
   # Allow port 3200 through firewall
   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /usr/local/bin/node
   sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp /usr/local/bin/node
   ```

3. Verify dashboard is running:
   ```bash
   lsof -i :3200
   ```

**IP changed:**
- Mac IP can change if router reboots
- Find new IP: `ifconfig | grep "inet " | grep -v 127.0.0.1`
- Or use Mac's hostname: `http://D1010-Mini.local:3200`

---

## Option 2: Cloudflare Tunnel (Remote Access)

For access from anywhere (not just same network):

### Install Cloudflare Tunnel

```bash
# Install cloudflared
brew install cloudflare/cloudflare/cloudflared

# Login
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create operations-dashboard

# Configure tunnel
cat > ~/.cloudflared/config.yml << EOF
tunnel: <tunnel-id>
credentials-file: ~/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: dashboard.digital1010.com
    service: http://localhost:3200
  - service: http_status:404
EOF

# Route DNS
cloudflared tunnel route dns operations-dashboard dashboard.digital1010.com

# Run tunnel
cloudflared tunnel run operations-dashboard
```

**Result:** Dashboard accessible at https://dashboard.digital1010.com

---

## Option 3: ngrok (Quick & Temporary)

For quick sharing or testing:

### Install & Run

```bash
# Install ngrok
brew install ngrok

# Start tunnel
ngrok http 3200
```

**Output:**
```
Forwarding  https://abc123.ngrok.io -> http://localhost:3200
```

Use the `https://abc123.ngrok.io` URL on any device.

**Note:** Free ngrok URLs change on restart. Pro plan gives persistent URLs.

---

## Option 4: Deploy to Server (Production)

For permanent hosting:

### Option A: Fly.io (Free Tier)

```bash
# Install flyctl
brew install flyctl

# Login
flyctl auth login

# Create app
flyctl launch

# Deploy
flyctl deploy
```

### Option B: Railway

1. Push code to GitHub
2. Connect Railway to repo
3. Deploy automatically

### Option C: VPS (DigitalOcean, Linode)

```bash
# On VPS
git clone <repo>
cd operations-dashboard
npm install
npm install -g pm2
pm2 start server.js --name operations-dashboard
pm2 startup
pm2 save

# Configure nginx reverse proxy
sudo apt install nginx
# ... nginx config for domain
```

---

## Recommended Setup

**For Daily Use:**
- **Same Network** (Option 1) - Fastest, no setup

**For Remote Access:**
- **Cloudflare Tunnel** (Option 2) - Free, secure, persistent

**For Quick Sharing:**
- **ngrok** (Option 3) - Instant, temporary

**For Production:**
- **Fly.io** (Option 4A) - Free tier, easy deployment

---

## Security Considerations

**Same Network (Option 1):**
- ✅ Most secure (only accessible on local network)
- ✅ No authentication needed
- ❌ Can't access remotely

**Cloudflare Tunnel (Option 2):**
- ✅ Encrypted connection
- ✅ No open ports on Mac
- ⚠️ Add authentication if dashboard goes public

**ngrok (Option 3):**
- ✅ Encrypted
- ⚠️ URL is guessable - don't share publicly
- ⚠️ Free tier disconnects after 2 hours

**Deployed (Option 4):**
- ✅ Always available
- ⚠️ MUST add authentication/password protection
- ⚠️ Requires server maintenance

---

## Quick Mobile Access (Right Now)

**Fastest path:**

1. Verify dashboard is running on Mac:
   ```bash
   curl http://localhost:3200
   ```

2. Find Mac's IP (already found: **192.168.1.23**)

3. On phone, open browser and go to:
   **http://192.168.1.23:3200**

4. Bookmark it for easy access

**If it doesn't work:**
- Restart dashboard server
- Check Mac firewall settings
- Verify both devices on same WiFi

---

## Bookmarklet for Easy Access

Save this in your phone's bookmarks:

**Name:** Operations Dashboard  
**URL:** `http://192.168.1.23:3200`

Or use hostname (may be more stable):

**URL:** `http://D1010-Mini.local:3200`

---

**Questions?** Check the main README.md for dashboard documentation.

**Status:** Local access ready now (http://192.168.1.23:3200)  
**Remote access:** Requires one of the tunnel/deploy options above
