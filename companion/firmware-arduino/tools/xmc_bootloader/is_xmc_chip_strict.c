/*
 * ESP-IDF 4.4.7 XMC recognition predicate, with the 0x70 family added.
 * Derived from Espressif's Apache-2.0 bootloader_flash.c:
 * https://github.com/espressif/esp-idf/blob/v4.4.7/components/bootloader_support/src/bootloader_flash.c
 * See https://github.com/espressif/esp-idf/issues/9952 and #18947.
 */
typedef unsigned int uint32_t;

__attribute__((noinline))
_Bool is_xmc_chip_strict(uint32_t rdid)
{
    const uint32_t vendor_id = (rdid >> 16) & 0xff;
    const uint32_t mfid = (rdid >> 8) & 0xff;
    const uint32_t cpid = rdid & 0xff;

    if (vendor_id != 0x20) {
        return 0;
    }
    if (mfid == 0x40) {
        return cpid >= 0x13 && cpid <= 0x20;
    }
    if (mfid == 0x41 || mfid == 0x70) {
        return cpid >= 0x17 && cpid <= 0x20;
    }
    if (mfid == 0x50) {
        return cpid >= 0x15 && cpid <= 0x16;
    }
    return 0;
}
