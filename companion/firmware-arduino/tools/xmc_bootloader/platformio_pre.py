"""PlatformIO pre script selecting the project-local XMC-compatible bootloader."""
from pathlib import Path
import runpy

Import("env")

board = env.BoardConfig()
if board.get("build.mcu") != "esp32s3" or board.get("build.flash_mode", "dio") != "dio":
    raise RuntimeError("XMC workaround supports ESP32-S3 DIO80 only")
if int(str(board.get("build.f_flash", "80000000L")).rstrip("L")) != 80000000:
    raise RuntimeError("XMC workaround requires an 80 MHz flash configuration")
platform = env.PioPlatform()
script_dir = Path(env.subst("$PROJECT_DIR")) / "tools" / "xmc_bootloader"
prepare = runpy.run_path(str(script_dir / "prepare.py"))["prepare"]
custom_bootloader = prepare(
    Path(platform.get_package_dir("framework-arduinoespressif32")),
    Path(platform.get_package_dir("toolchain-xtensa-esp32s3")),
    Path(platform.get_package_dir("tool-esptoolpy")) / "esptool.py",
    Path(env.subst("$BUILD_DIR")) / "xmc_bootloader",
)
board.update("build.arduino.custom_bootloader", str(custom_bootloader.resolve()))
