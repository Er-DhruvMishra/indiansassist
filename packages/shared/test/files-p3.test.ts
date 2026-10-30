/** Phase C section 6.1 F3/F4: the extended risk lists and the fixture the Rust port is checked against. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXECUTABLE_EXTENSIONS,
  PASSIVE_RISK_EXTENSIONS,
  RESERVED_DEVICE_STEMS,
  hasReservedDeviceStem,
  isExecutableName,
  isPassiveRiskName,
} from '../src/index.js';

const lists = JSON.parse(readFileSync(new URL('./fixtures/agent/file-lists.json', import.meta.url), 'utf8')) as {
  executableExtensions: string[];
  passiveRiskExtensions: string[];
  reservedDeviceStems: string[];
};

describe('Phase C file lists', () => {
  it('the cross-language fixture equals the exported lists', () => {
    expect(lists.executableExtensions).toEqual([...EXECUTABLE_EXTENSIONS]);
    expect(lists.passiveRiskExtensions).toEqual([...PASSIVE_RISK_EXTENSIONS]);
    expect(lists.reservedDeviceStems).toEqual([...RESERVED_DEVICE_STEMS]);
  });

  it('EXECUTABLE_EXTENSIONS carries the F4 additions', () => {
    for (const e of ['pif', 'appref-ms', 'diagcab', 'ps1xml', 'msh2xml']) expect(isExecutableName(`x.${e}`)).toBe(true);
    expect(isExecutableName('notes.txt')).toBe(false);
  });

  it('PASSIVE_RISK_EXTENSIONS', () => {
    expect(isPassiveRiskName('evil.URL')).toBe(true);
    expect(isPassiveRiskName('a.searchconnector-ms')).toBe(true);
    expect(isPassiveRiskName('photo.png')).toBe(false);
    expect(isPassiveRiskName('.url')).toBe(false);
  });

  it('reserved device stems', () => {
    expect(hasReservedDeviceStem('con.txt')).toBe(true);
    expect(hasReservedDeviceStem(String.raw`dir\AUX.log`)).toBe(true);
    expect(hasReservedDeviceStem('dir/nul')).toBe(true);
    expect(hasReservedDeviceStem('lpt9')).toBe(true);
    expect(hasReservedDeviceStem('console.txt')).toBe(false);
    expect(hasReservedDeviceStem('com10.txt')).toBe(false);
  });
});
