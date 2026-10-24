"""Generate a project-local Arduino 2.0.17 ESP32-S3 DIO80 XMC bootloader.

The installed framework is never modified. A new C recognition predicate is
compiled, appended to the original bootloader's IRAM load section, and reached
through an assembled jump at the old predicate entry. A guarded ELF insertion
preserves the existing load layout. esptool regenerates the image checksum and
SHA256. Unknown framework binaries fail closed.
"""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import struct
import subprocess
import sys

EXPECTED_SHA256 = "787c681f6796924f7c9953d46ea45953001e1ad6a780c30e137bbdf8d21a1426"
SECTION_NAME = ".iram_loader.text"
SECTION_ADDR = 0x403CC700
ORIGINAL_FUNCTION_ADDR = 0x403CD148
ORIGINAL_FUNCTION_BYTES = bytes.fromhex(
    "3641002090758d020c0266c93680987480807466d90e82c8ed0c190cda"
    "87ba209d02c606004c1aa7990982c8e90c190c9a06faff5c0aa7990a"
    "82c8eb0c19f628de9020741df0"
)


def require(condition: bool, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


def run(args: list[str | Path]) -> str:
    result = subprocess.run(
        [str(arg) for arg in args], check=False, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    require(result.returncode == 0, f"Command failed: {args[0]}\n{result.stdout}")
    return result.stdout


def elf_sections(path: Path) -> tuple[bytes, dict[str, dict[str, int]], list[tuple[int, ...]]]:
    data = path.read_bytes()
    require(data[:7] == b"\x7fELF\x01\x01\x01", "Expected little-endian ELF32")
    header = struct.unpack_from("<16sHHIIIIIHHHHHH", data)
    require(header[2] == 94, "Expected Xtensa ELF machine type")
    phoff, shoff = header[5:7]
    phentsize, phnum, shentsize, shnum, shstrndx = header[9:14]
    require(phentsize == 32 and shentsize == 40, "Unexpected ELF table layout")
    headers = [struct.unpack_from("<10I", data, shoff + i * shentsize) for i in range(shnum)]
    names_header = headers[shstrndx]
    names = data[names_header[4]:names_header[4] + names_header[5]]
    sections = {}
    for item in headers:
        end = names.index(b"\0", item[0])
        name = names[item[0]:end].decode("ascii")
        sections[name] = {"addr": item[3], "offset": item[4], "size": item[5],
                          "type": item[1], "flags": item[2], "align": item[8]}
    programs = [struct.unpack_from("<8I", data, phoff + i * phentsize) for i in range(phnum)]
    return data, sections, programs


def append_load_section(original: bytes, section: dict[str, int], contents: bytes) -> bytes:
    """Extend one final-in-segment section without relocating earlier sections."""
    require(len(contents) > section["size"], "Expected an extended section")
    header = struct.unpack_from("<16sHHIIIIIHHHHHH", original)
    phoff, shoff = header[5:7]
    phentsize, phnum, shentsize, shnum = header[9:13]
    insertion = section["offset"] + section["size"]
    extension = contents[section["size"]:]
    delta = len(extension)
    # Keep the following four-byte-aligned debug/symbol tables aligned. These
    # extra file bytes are outside the extended runtime load segment.
    file_extension = extension + b"\0" * (-delta % 4)
    file_delta = len(file_extension)
    result = bytearray(original)
    result[insertion:insertion] = file_extension
    result[section["offset"]:section["offset"] + section["size"]] = contents[:section["size"]]
    require(phoff < insertion < shoff, "Unsupported ELF insertion layout")
    new_shoff = shoff + file_delta
    struct.pack_into("<I", result, 32, new_shoff)
    changed_programs = 0
    for index in range(phnum):
        position = phoff + index * phentsize
        program = list(struct.unpack_from("<8I", original, position))
        if program[0] == 1 and program[1] == section["offset"] and program[2] == section["addr"]:
            require(program[4] == section["size"] and program[5] == section["size"],
                    "Section is not the entire original load segment")
            program[4] += delta
            program[5] += delta
            changed_programs += 1
        elif program[1] >= insertion:
            program[1] += file_delta
        struct.pack_into("<8I", result, position, *program)
    require(changed_programs == 1, "Expected exactly one extended load segment")
    changed_sections = 0
    for index in range(shnum):
        item = list(struct.unpack_from("<10I", original, shoff + index * shentsize))
        if item[3] == section["addr"] and item[4] == section["offset"]:
            require(item[5] == section["size"], "Original ELF section length differs")
            item[5] += delta
            changed_sections += 1
        elif item[4] >= insertion:
            item[4] += file_delta
        struct.pack_into("<10I", result, new_shoff + index * shentsize, *item)
    require(changed_sections == 1, "Expected exactly one extended ELF section")
    return bytes(result)


def executable(toolchain: Path, name: str) -> Path:
    path = toolchain / "bin" / ("xtensa-esp32s3-elf-" + name)
    if not path.is_file():
        path = path.with_suffix(".exe")
    require(path.is_file(), f"Missing tool: {path}")
    return path


def prepare(framework: Path, toolchain: Path, esptool: Path, output_dir: Path) -> Path:
    original = framework / "tools/sdk/esp32s3/bin/bootloader_dio_80m.elf"
    original_data, sections, _ = elf_sections(original)
    require(hashlib.sha256(original_data).hexdigest() == EXPECTED_SHA256,
            "Unsupported framework bootloader; expected the verified Arduino 2.0.17 DIO80 ELF")
    section = sections[SECTION_NAME]
    require(section["addr"] == SECTION_ADDR and section["size"] == 0x28AB,
            "Original load section layout differs")
    original_section = original_data[section["offset"]:section["offset"] + section["size"]]
    function_offset = ORIGINAL_FUNCTION_ADDR - SECTION_ADDR
    require(original_section[function_offset:function_offset + len(ORIGINAL_FUNCTION_BYTES)]
            == ORIGINAL_FUNCTION_BYTES, "Original XMC predicate bytes differ")

    output_dir.mkdir(parents=True, exist_ok=True)
    compiler = executable(toolchain, "gcc")
    assembler = executable(toolchain, "as")
    linker = executable(toolchain, "ld")
    objcopy = executable(toolchain, "objcopy")
    objdump = executable(toolchain, "objdump")
    nm = executable(toolchain, "nm")
    replacement_addr = (SECTION_ADDR + section["size"] + 15) & ~15
    source = Path(__file__).with_name("is_xmc_chip_strict.c")
    predicate_obj = output_dir / "xmc_predicate.o"
    predicate_elf = output_dir / "xmc_predicate.elf"
    predicate_bin = output_dir / "xmc_predicate.bin"
    run([compiler, "-Os", "-mlongcalls", "-ffunction-sections", "-fno-jump-tables",
         "-fno-tree-switch-conversion", "-c", source, "-o", predicate_obj])
    run([linker, "-Ttext", hex(replacement_addr), "--entry=is_xmc_chip_strict",
         predicate_obj, "-o", predicate_elf])
    require(not run([nm, "-u", predicate_elf]).strip(), "Predicate has unresolved references")
    run([objcopy, "-O", "binary", "--only-section=.text", predicate_elf, predicate_bin])
    replacement = predicate_bin.read_bytes()
    require(0 < len(replacement) <= 256, "Unexpected replacement predicate length")
    _, predicate_sections, _ = elf_sections(predicate_elf)
    require(predicate_sections[".text"]["addr"] == replacement_addr,
            "Replacement linked at the wrong address")
    require(replacement_addr + len(replacement) <= SECTION_ADDR + 0x7000,
            "Replacement exceeds the stock bootloader IRAM loader region")

    trampoline_source = output_dir / "xmc_trampoline.S"
    trampoline_obj = output_dir / "xmc_trampoline.o"
    trampoline_elf = output_dir / "xmc_trampoline.elf"
    trampoline_bin = output_dir / "xmc_trampoline.bin"
    trampoline_source.write_text(
        ".text\n.global xmc_trampoline\nxmc_trampoline:\nj xmc_predicate_target\n", encoding="ascii"
    )
    run([assembler, trampoline_source, "-o", trampoline_obj])
    run([linker, "-Ttext", hex(ORIGINAL_FUNCTION_ADDR), "--entry=xmc_trampoline",
         "--defsym=xmc_predicate_target=" + hex(replacement_addr),
         trampoline_obj, "-o", trampoline_elf])
    run([objcopy, "-O", "binary", "--only-section=.text", trampoline_elf, trampoline_bin])
    trampoline = trampoline_bin.read_bytes()
    require(len(trampoline) == 3, "Expected a three-byte Xtensa jump")
    # Xtensa J: low six opcode bits 000110, signed 18-bit PC+4 displacement.
    instruction = int.from_bytes(trampoline, "little")
    require(instruction & 0x3F == 6, "Trampoline is not a J instruction")
    displacement = instruction >> 6
    if displacement & (1 << 17):
        displacement -= 1 << 18
    require(ORIGINAL_FUNCTION_ADDR + 4 + displacement == replacement_addr,
            "Trampoline jumps to an unexpected address")

    patched_section = bytearray(original_section)
    patched_section[function_offset:function_offset + 3] = trampoline
    patched_section.extend(b"\0" * (replacement_addr - SECTION_ADDR - len(patched_section)))
    patched_section.extend(replacement)
    section_bin = output_dir / "xmc_loader_section.bin"
    section_bin.write_bytes(patched_section)
    patched_elf = output_dir / "bootloader_xmc_207018.elf"
    patched_elf.write_bytes(append_load_section(original_data, section, patched_section))
    patched_data, patched_sections, programs = elf_sections(patched_elf)
    patched_load = patched_sections[SECTION_NAME]
    require(patched_load["addr"] == SECTION_ADDR and patched_load["size"] == len(patched_section),
            "Patched ELF section layout differs")
    require(patched_data[patched_load["offset"]:patched_load["offset"] + patched_load["size"]]
            == patched_section, "Patched ELF section contents differ")
    require(any(p[0] == 1 and p[2] == SECTION_ADDR and p[4] == len(patched_section)
                and p[5] == len(patched_section) for p in programs),
            "ELF load segment does not include the replacement code")
    for name, item in patched_sections.items():
        require(not item["align"] or item["offset"] % item["align"] == 0,
                f"ELF section file alignment changed: {name}")
        if item["flags"] & 2 and item["size"]:
            require(any(p[0] == 1 and p[2] <= item["addr"]
                        and item["addr"] + item["size"] <= p[2] + p[5]
                        and (item["type"] == 8 or (p[1] <= item["offset"]
                             and item["offset"] + item["size"] <= p[1] + p[4]
                             and item["offset"] - p[1] == item["addr"] - p[2]))
                        for p in programs), f"ELF section is outside its load segment: {name}")
    for name, original_header in sections.items():
        if name != SECTION_NAME and original_header["size"] and name in patched_sections:
            final_header = patched_sections[name]
            require(original_header["addr"] == final_header["addr"]
                    and original_header["size"] == final_header["size"], f"Other ELF section changed: {name}")
            require(original_data[original_header["offset"]:original_header["offset"] + original_header["size"]]
                    == patched_data[final_header["offset"]:final_header["offset"] + final_header["size"]],
                    f"Other ELF section contents changed: {name}")

    output_bin = output_dir / "bootloader_xmc_207018.bin"
    run([sys.executable, esptool, "--chip", "esp32s3", "elf2image", "--flash_mode", "dio",
         "--flash_freq", "80m", "--flash_size", "16MB", "-o", output_bin, patched_elf])
    require(output_bin.stat().st_size < 0x8000, "Bootloader overlaps the partition table")
    image_info = run([sys.executable, esptool, "--chip", "esp32s3", "image_info", output_bin])
    integrity_lines = [line for line in image_info.splitlines()
                       if line.startswith(("Checksum:", "Validation Hash:"))]
    require(len(integrity_lines) == 2 and all("(valid)" in line for line in integrity_lines),
            "Image checksum or SHA256 validation failed")
    report = (
        "Original ELF SHA256: " + EXPECTED_SHA256 + "\n"
        + f"Original predicate: 0x{ORIGINAL_FUNCTION_ADDR:08x}\n"
        + f"Replacement predicate: 0x{replacement_addr:08x} ({len(replacement)} bytes)\n"
        + f"Trampoline bytes: {trampoline.hex()}\n"
        + "Generated BIN SHA256: " + hashlib.sha256(output_bin.read_bytes()).hexdigest() + "\n\n"
        + run([objdump, "-d", trampoline_elf]) + "\n"
        + run([objdump, "-d", predicate_elf]) + "\n" + image_info
    )
    (output_dir / "verification.txt").write_text(report, encoding="utf-8")
    print(f"XMC bootloader prepared: {output_bin}")
    return output_bin


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--framework", type=Path, required=True)
    parser.add_argument("--toolchain", type=Path, required=True)
    parser.add_argument("--esptool", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    prepare(args.framework, args.toolchain, args.esptool, args.output_dir)


if __name__ == "__main__":
    main()
