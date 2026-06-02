import { describe, expect, it } from 'vitest';

import { normalizeConfig } from '../core/config.js';

describe('control config normalization', () => {
  it('defaults control to enabled on loopback:8765', () => {
    const { control } = normalizeConfig({});
    expect(control).toEqual({ enabled: true, host: '127.0.0.1', port: 8765 });
  });

  it('honors explicit control overrides', () => {
    const { control } = normalizeConfig({
      control: { enabled: false, host: '127.0.0.1', port: 9000 },
    });
    expect(control).toEqual({ enabled: false, host: '127.0.0.1', port: 9000 });
  });

  it('accepts flat controlEnabled/controlHost/controlPort keys', () => {
    const { control } = normalizeConfig({
      controlEnabled: 'false',
      controlHost: '127.0.0.1',
      controlPort: '7000',
    });
    expect(control).toEqual({ enabled: false, host: '127.0.0.1', port: 7000 });
  });

  it('falls back to defaults for invalid port and missing host', () => {
    const { control } = normalizeConfig({ control: { port: 'not-a-number' } });
    expect(control.host).toBe('127.0.0.1');
    expect(control.port).toBe(8765);
    expect(control.enabled).toBe(true);
  });

  it('leaves the existing mcp config untouched', () => {
    const config = normalizeConfig({ mcp: { enabled: true, port: 8080 } });
    expect(config.mcp).toMatchObject({ enabled: true, port: 8080 });
    expect(config.control.enabled).toBe(true);
  });
});
