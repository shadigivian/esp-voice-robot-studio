"""Provision managed voice through a trusted USB cable; never send a cloud API key."""
import argparse
import json
from pathlib import Path
import secrets
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    generate = commands.add_parser("new-secret", help="Write a unique device bootstrap secret")
    generate.add_argument("--out", required=True)
    for action in ("status", "pairing", "provision"):
        command = commands.add_parser(action)
        command.add_argument("--port", required=True, help="USB serial port, for example COM7")
        if action == "provision":
            command.add_argument("--origin", required=True, help="Management HTTPS origin")
            command.add_argument("--voice-host", required=True)
            command.add_argument("--voice-port", type=int, default=443)
            command.add_argument("--ca-file", required=True)
            command.add_argument("--bootstrap-file", required=True)
    args = parser.parse_args()
    if args.action == "new-secret":
        destination = Path(args.out)
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("x", encoding="ascii") as output:
            output.write(secrets.token_hex(32) + "\n")
        print("Unique bootstrap secret saved. Contents are not displayed.")
        return
    import serial

    if args.action == "provision":
        secret = Path(args.bootstrap_file).read_text(encoding="ascii").strip()
        ca = Path(args.ca_file).read_text(encoding="utf-8").strip() + "\n"
        if not 32 <= len(secret) <= 256 or any(not 33 <= ord(c) <= 126 for c in secret):
            raise ValueError("The bootstrap file must contain 32-256 printable characters without spaces.")
        if len(ca) > 6144 or not ca.startswith("-----BEGIN CERTIFICATE-----") or "-----END CERTIFICATE-----" not in ca:
            raise ValueError("Supply the trusted root CA PEM or bundle (at most 6144 characters).")
        body = dict(cmd="management", origin=args.origin, bootstrapSecret=secret,
                    voiceHost=args.voice_host, voicePort=args.voice_port, ca=ca)
        expected = "[SETUP] MANAGEMENT_SAVED"
    else:
        body = {"cmd": "pairing_code" if args.action == "pairing" else "network_status"}
        expected = "[SETUP] PAIRING" if args.action == "pairing" else "[SETUP] NETWORK"
    wire = ("ELATO_SETUP " + json.dumps(body, ensure_ascii=True, separators=(",", ":")) + "\n").encode("ascii")
    if len(wire) > 8192:
        raise ValueError("The provisioning message exceeds the firmware serial limit.")
    connection = serial.Serial()
    connection.port = args.port
    connection.baudrate = 115200
    connection.timeout = 0.25
    connection.write_timeout = 5
    connection.dtr = False
    connection.rts = False
    with connection:
        # Opening some USB bridges restarts the board. Handshake before sending secrets.
        deadline = time.monotonic() + 20
        ready = False
        while time.monotonic() < deadline and not ready:
            connection.write(b'ELATO_SETUP {"cmd":"status"}\n')
            attempt = time.monotonic() + 1
            while time.monotonic() < attempt:
                if connection.readline().decode("utf-8", errors="replace").strip() == "[SETUP] READY":
                    ready = True
                    break
        if not ready:
            raise RuntimeError("Firmware did not acknowledge USB setup. Check port, build and serial monitor.")
        connection.write(wire)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            line = connection.readline().decode("utf-8", errors="replace").strip()
            if line.startswith(expected):
                print(line)
                return
            if line.startswith("[SETUP] ERROR"):
                raise RuntimeError(line)
    raise RuntimeError("No setup acknowledgement received. No credentials are displayed.")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # OS/serial errors must not include serialized configuration or secret values.
        if isinstance(error, (ValueError, RuntimeError)):
            raise SystemExit(str(error)) from None
        raise SystemExit("USB setup failed. Check the files, serial port and pyserial installation. No secrets are displayed.") from None
