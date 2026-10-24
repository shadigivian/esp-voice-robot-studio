# Qwen companion firmware

`firmware-arduino/` contains the complete Arduino source configuration used for
the supplied ESP32-S3 circuit. It preserves ElatoAI attribution and the local
audio/Wi-Fi improvements. The firmware owns no Qwen cloud credentials.

Build directly in `companion/firmware-arduino`, or install these source files
into an existing compatible ElatoAI checkout:

```sh
node scripts/install-companion.mjs /path/to/ElatoAI --firmware
node scripts/install-companion.mjs /path/to/ElatoAI --firmware --write
```

The first command previews destinations. The second backs up changed original
files under `.local/companion-backups` and installs the firmware plus the managed
voice adapter into the existing Deno listener. Private `.env` files are not
copied or overwritten. Files absent from the manifest are left in place. The
firmware-only package manifest lists source files, not generated build output.
The server installation also applies narrow ambient-type and callback guards
required by the compatible ElatoAI revision to pass native `deno check`. Unknown
server revisions are rejected before files are written. Dependency versions and
the existing lockfile are preserved.

See the [Persian Qwen setup guide](../docs/qwen-setup.fa.md) and
[firmware wiring/provisioning](../docs/qwen-firmware.md). The OLED controller is
still unknown; explicit USB pairing is available. Confirm the exact board's
flash/PSRAM and serial port before uploading. The source currently targets
16 MB flash, OPI PSRAM, and the documented microphone/amplifier/touch pins.
