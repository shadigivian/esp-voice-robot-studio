"""Send one selected Windows Wi-Fi profile to the connected ESP32 over USB.

The password stays in memory: it is never printed, written to a file, or
passed as a command-line argument. The firmware must acknowledge readiness
before the Windows profile is read.
"""
import argparse
import ctypes
from ctypes import wintypes
import json
import os
import sys
import time
import xml.etree.ElementTree as ET

import serial
from serial.tools import list_ports


class SetupError(Exception):
    pass


class GUID(ctypes.Structure):
    _fields_ = [("Data1", wintypes.DWORD), ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD), ("Data4", ctypes.c_ubyte * 8)]


class WLAN_INTERFACE_INFO(ctypes.Structure):
    _fields_ = [("guid", GUID), ("description", ctypes.c_wchar * 256),
                ("state", wintypes.DWORD)]


def selected_profile(profile_name, expected_ssid):
    if os.name != "nt":
        raise SetupError("This utility requires Windows.")
    wlan = ctypes.WinDLL("wlanapi.dll")
    wlan.WlanOpenHandle.argtypes = [wintypes.DWORD, ctypes.c_void_p,
                                   ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.HANDLE)]
    wlan.WlanOpenHandle.restype = wintypes.DWORD
    wlan.WlanEnumInterfaces.argtypes = [wintypes.HANDLE, ctypes.c_void_p,
                                       ctypes.POINTER(ctypes.c_void_p)]
    wlan.WlanEnumInterfaces.restype = wintypes.DWORD
    wlan.WlanGetProfile.argtypes = [wintypes.HANDLE, ctypes.POINTER(GUID), wintypes.LPCWSTR,
                                   ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p),
                                   ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(wintypes.DWORD)]
    wlan.WlanGetProfile.restype = wintypes.DWORD
    wlan.WlanFreeMemory.argtypes = [ctypes.c_void_p]
    wlan.WlanCloseHandle.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
    client = wintypes.HANDLE()
    negotiated = wintypes.DWORD()
    result = wlan.WlanOpenHandle(2, None, ctypes.byref(negotiated), ctypes.byref(client))
    if result:
        raise SetupError(f"Windows WLAN service error {result}.")
    interfaces = ctypes.c_void_p()
    try:
        result = wlan.WlanEnumInterfaces(client, None, ctypes.byref(interfaces))
        if result:
            raise SetupError(f"Windows WLAN interface error {result}.")
        count = ctypes.cast(interfaces, ctypes.POINTER(wintypes.DWORD))[0]
        for index in range(count):
            info = WLAN_INTERFACE_INFO.from_address(
                interfaces.value + 8 + index * ctypes.sizeof(WLAN_INTERFACE_INFO))
            profile_xml = ctypes.c_void_p()
            flags = wintypes.DWORD(4)  # WLAN_PROFILE_GET_PLAINTEXT_KEY, selected profile only.
            access = wintypes.DWORD()
            result = wlan.WlanGetProfile(client, ctypes.byref(info.guid), profile_name,
                                         None, ctypes.byref(profile_xml),
                                         ctypes.byref(flags), ctypes.byref(access))
            if result == 1168:  # Selected profile is not on this interface.
                continue
            if result:
                raise SetupError(f"Cannot read the selected Windows profile (error {result}).")
            try:
                document = ET.fromstring(ctypes.wstring_at(profile_xml))
            finally:
                wlan.WlanFreeMemory(profile_xml)
            ssid = document.findtext("{*}SSIDConfig/{*}SSID/{*}name")
            if ssid != expected_ssid:
                raise SetupError("The selected profile does not match the requested SSID.")
            authentication = document.findtext("{*}MSM/{*}security/{*}authEncryption/{*}authentication")
            shared_key = document.find("{*}MSM/{*}security/{*}sharedKey")
            if shared_key is None:
                if authentication != "open":
                    raise SetupError("The selected profile has no usable personal Wi-Fi key.")
                password = ""
            else:
                if shared_key.findtext("{*}protected") != "false":
                    raise SetupError("Windows did not provide the selected key in usable form.")
                password = shared_key.findtext("{*}keyMaterial")
                if password is None:
                    raise SetupError("The selected profile has no key material.")
            ssid_size = len(ssid.encode("utf-8"))
            password_size = len(password.encode("utf-8"))
            if not 1 <= ssid_size <= 32 or "\0" in ssid or "\0" in password:
                raise SetupError("The selected profile contains unsupported Wi-Fi values.")
            if password_size and not 8 <= password_size <= 63:
                raise SetupError("The selected password length is unsupported.")
            return ssid, password
        raise SetupError("The requested Windows profile was not found.")
    finally:
        if interfaces:
            wlan.WlanFreeMemory(interfaces)
        wlan.WlanCloseHandle(client, None)


def wait_for_ack(connection, expected, seconds=8):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        line = connection.readline().decode("utf-8", errors="replace").strip()
        if line == "[SETUP] " + expected:
            return
        if line.startswith("[SETUP] ERROR_"):
            # Only fixed firmware error codes are eligible for display.
            code = line.removeprefix("[SETUP] ")
            if code in {"ERROR_BUSY", "ERROR_CREDENTIALS", "ERROR_STORAGE",
                        "ERROR_STORAGE_ROLLBACK", "ERROR_COMMAND", "ERROR_JSON",
                        "ERROR_TIMEOUT", "ERROR_LENGTH"}:
                raise SetupError("ESP32 setup returned " + code + ".")
            raise SetupError("ESP32 setup rejected the request.")
    raise SetupError("ESP32 setup acknowledgment timed out.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--ssid", required=True)
    parser.add_argument("--device-serial", required=True)
    args = parser.parse_args()
    matches = [port for port in list_ports.comports()
               if port.vid == 0x1A86 and port.pid == 0x55D3
               and port.serial_number == args.device_serial]
    if len(matches) != 1:
        raise SetupError("The specified ESP32 USB adapter was not uniquely identified.")
    connection = serial.Serial(port=None, baudrate=115200, timeout=0.25, write_timeout=3)
    connection.dtr = False
    connection.rts = False
    connection.port = matches[0].device
    try:
        connection.open()
        connection.reset_input_buffer()
        connection.write(b'ELATO_SETUP {"cmd":"status"}\n')
        connection.flush()
        # The main loop may still be completing its initial Wi-Fi attempt.
        wait_for_ack(connection, "READY", seconds=30)
        ssid, password = selected_profile(args.profile, args.ssid)
        packet = ("ELATO_SETUP " + json.dumps(
            {"cmd": "wifi", "ssid": ssid, "password": password},
            ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        if len(packet) - 1 > 511:
            raise SetupError("The selected profile exceeds the USB command limit.")
        connection.write(packet)
        connection.flush()
        wait_for_ack(connection, "WIFI_SAVED")
        print("Wi-Fi configuration saved and verified on ESP32; device is restarting.")
    finally:
        connection.close()


if __name__ == "__main__":
    try:
        main()
    except SetupError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("USB provisioning failed; no credentials were displayed.", file=sys.stderr)
        sys.exit(1)
