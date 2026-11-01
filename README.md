# Postcard Printer

A small local web app for composing **6×4″ postcards** out of images — place, scale,
rotate and **dither** each image, overlay them freely — and print straight to a
**Phomemo PM-241 / PM643 (4×6″, 300 dpi, WiFi/AirPrint)** thermal printer with **no popups**.

Inspired by [prepostprint](https://prepostprint.org/).

## Why a local server?

Browsers can't open a raw network connection to a printer, so a pure webpage can't
print over WiFi silently. This app runs a tiny **zero-dependency Node server** on your
Mac that serves the editor and hands the finished image to macOS's print system
(`lp` → CUPS → AirPrint/IPP). No browser print dialog, no popups.

## Run

```bash
cd postcard-printer
node server.js
```

Then open <http://localhost:8787>.

Requires Node 18+ and macOS (uses `lp` / `lpstat` / `lpadmin`).

## Using it

The interface is deliberately minimal (after [prepostprint](https://prepostprint.org/)):
a floating canvas and a few flat black controls.

- **Add images** — the `+` button (top-left), drag-and-drop onto the canvas, or paste (⌘V).
- **Left strip** shows every image you added (top layer first). Click a thumbnail to select it;
  the selected one has a white outline.
- **On the canvas** — drag to move, corner handles to scale, the top knob to rotate.
  Scroll wheel scales; arrow keys nudge; Delete removes; Esc deselects.
- **Bottom bar** (appears when an image is selected) — the dither button cycles
  Floyd–Steinberg → Atkinson → Bayer → threshold → no-dither; plus brightness / contrast /
  opacity sliders, invert, layer order (↓ ↑) and delete (✕).
- **`6×4` button** flips between 6×4 landscape and 4×6 portrait.
- **`⚙`** opens printer selection, `+ wifi`, and the raw `lp` options.
- **`export`** saves a PNG; **`print`** sends it to the printer.

## Printing

1. Open **`⚙`** and pick the printer. The app lists installed CUPS queues and does a quick
   AirPrint discovery, and auto-selects the working `PM643_usb` queue.
2. For a WiFi setup instead, use **+ wifi** and enter the printer's IP once — it's added as a
   driverless (IPP Everywhere) queue that negotiates the 4×6 media and 300 dpi.
3. Click **print**. The full-resolution image is rendered and sent silently.

### Tuning the print size

The `lp` options sent with each job are editable under **`⚙`** (saved locally). Default:

```
-o PageSize=w288h432 -o print-color-mode=monochrome
```

If the label comes out the wrong size, the printer may expect a different media name
(e.g. `media=custom_4x6in_101.6x152.4mm` or `om_label_...` on some driverless queues).
Any `lp` error is shown in-app so you can adjust. List a queue's supported media with:

```bash
lpoptions -p <queue> -l | grep -i media
```

## Workshop mode (shared print queue)

For a workshop where people design on their own devices and one Phomemo (on your
Mac) does the printing — especially on networks with client isolation like
**eduroam** — use the pull queue. Everything is **outbound HTTPS**, so nothing has
to reach your Mac directly.

- The **public server** (dokploy, `ROLE=queue`) collects designs. Participants open
  the site, design, enter a **name**, and hit **send to print**; the job lands in a
  queue. No login — fine for a short-lived workshop site.
- You review and approve at **`/overview`**. Only approved jobs get printed.
- Your **Mac runs the pull agent**, which fetches approved jobs and prints them
  locally via `lp`:

  ```bash
  QUEUE_URL=https://tool.poetic.software \
  PRINTER=PM643_usb \
  node server.js --agent
  ```

  Add `--auto` (or `AUTO=1`) to print every submission immediately, skipping the
  approve step. `POLL_MS` sets the poll interval (default 4000).

  **Test without the printer:** add `--dry-run` (or `DRY_RUN=1`). The agent still
  polls, fetches approved jobs and marks them **done**, but instead of printing it
  saves each design's PNG to `./dryrun/` (override with `DRY_DIR`). This exercises
  the whole eduroam round-trip (submit → approve → agent pulls over HTTPS) so you
  can confirm everything works on-site before the printer is there. Example:

  ```bash
  QUEUE_URL=https://tool.poetic.software node server.js --agent --dry-run
  ```

Queue-server env: `ROLE=queue` and `JOBS_DIR` pointed at a mounted volume so the
queue survives redeploys. **Optional auth** (if the site must stay up longer): set
`ROOM_CODE` to gate submissions and `ADMIN_TOKEN` to gate `/overview` and the agent
(pass the same `ADMIN_TOKEN` to the agent command).

## Files

- `server.js` — static server + `/api/printers`, `/api/add-wifi`, `/api/print`,
  the print-queue API (`/api/config`, `/api/jobs…`), and the `--agent` pull printer.
- `public/index.html`, `public/style.css`, `public/app.js` — the editor.
- `public/overview.html` — the facilitator overview (approve / reject prints).
