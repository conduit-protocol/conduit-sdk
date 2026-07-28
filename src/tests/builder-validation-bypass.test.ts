import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConduitBatcher, StreamBuilder } from '../builder.js';

describe('ConduitBatcher validation', () => {
  beforeEach(() => {
    ConduitBatcher.reset();
  });

  afterEach(() => {
    ConduitBatcher.reset();
  });

  it('should reject null payload', () => {
    const result = ConduitBatcher.execute(null as any);
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('null'))).toBe(true);
  });

  it('should reject undefined payload', () => {
    const result = ConduitBatcher.execute(undefined as any);
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('undefined'))).toBe(true);
  });

  it('should reject non-array payload', () => {
    const result = ConduitBatcher.execute('not an array' as any);
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('array'))).toBe(true);
  });

  it('should reject array with null items', () => {
    const result = ConduitBatcher.execute([null] as any);
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('null'))).toBe(true);
  });

  it('should reject array with undefined items', () => {
    const result = ConduitBatcher.execute([undefined] as any);
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('undefined'))).toBe(true);
  });

  it('should reject array with non-object items', () => {
    const result = ConduitBatcher.execute(['not an object'] as any);
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('must be an object'))).toBe(true);
  });

  it('should reject item with invalid token (non C-address)', () => {
    const result = ConduitBatcher.execute([
      { token: 'not-a-valid-contract', sender: 'GA1', recipient: 'GB1', amount: 100 },
    ]);
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('token') && e.includes('C-address'))).toBe(true);
  });

  it('should reject item with invalid sender (non G-address)', () => {
    const result = ConduitBatcher.execute([
      { token: 'CDLZFC3SYJYDZT7K3VZ3B7GJ4G5FCAH5G6O6V7J7K7L7M7N7O7P7Q7R7S', sender: 'not-a-valid-key', recipient: 'GB1', amount: 100 },
    ]);
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('sender') && e.includes('public key'))).toBe(true);
  });

  it('should reject item with invalid recipient (non G-address)', () => {
    const result = ConduitBatcher.execute([
      { token: 'CDLZFC3SYJYDZT7K3VZ3B7GJ4G5FCAH5G6O6V7J7K7L7M7N7O7P7Q7R7S', sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', recipient: 'bad-recipient', amount: 100 },
    ]);
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('recipient') && e.includes('public key'))).toBe(true);
  });

  it('should reject item with zero amount', () => {
    const result = ConduitBatcher.execute([
      { token: 'CDLZFC3SYJYDZT7K3VZ3B7GJ4G5FCAH5G6O6V7J7K7L7M7N7O7P7Q7R7S', sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', recipient: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', amount: 0 },
    ]);
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('amount') && e.includes('positive'))).toBe(true);
  });

  it('should reject item with negative amount', () => {
    const result = ConduitBatcher.execute([
      { token: 'CDLZFC3SYJYDZT7K3VZ3B7GJ4G5FCAH5G6O6V7J7K7L7M7N7O7P7Q7R7S', sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', recipient: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN', amount: -50 },
    ]);
    expect(result.success).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors?.some(e => e.includes('amount'))).toBe(true);
  });

  it('should accept valid object array with proper addresses', () => {
    const validPayload = [{
      method: 'create',
      params: { amount: 100 },
      token: 'CDLZFC3SYJYDZT7K3VZ3B7GJ4G5FCAH5G6O6V7J7K7L7M7N7O7P7Q7R7S',
      sender: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      recipient: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
    }];
    const result = ConduitBatcher.execute(validPayload);
    expect(result.success).toBe(true);
    expect(result.operations).toBe(1);
  });

  it('should not validate missing optional fields', () => {
    // Items without token/sender/recipient fields should not trigger address validation
    const result = ConduitBatcher.execute([
      { method: 'create', params: { amount: 100 } },
    ]);
    expect(result.success).toBe(true);
    expect(result.operations).toBe(1);
  });

  it('should handle bigint fields safely in payload', () => {
    const payloadWithBigInt = [{ method: 'create', params: { amount: 100n } }];
    const result = ConduitBatcher.execute(payloadWithBigInt);
    expect(result.success).toBe(true);
    expect(result.operations).toBe(1);
  });

  it('should throw when trying to execute after destroy', () => {
    ConduitBatcher.destroy();
    expect(() => ConduitBatcher.execute([])).toThrow(/destroyed/i);
  });
});

describe('StreamBuilder address validation', () => {
  it('should accept valid token (C-address)', () => {
    const builder = new StreamBuilder();
    expect(() => builder.token('CDLZFC3SYJYDZT7K3VZ3B7GJ4G5FCAH5G6O6V7J7K7L7M7N7O7P7Q7R7S')).not.toThrow();
  });

  it('should reject invalid token address', () => {
    const builder = new StreamBuilder();
    expect(() => builder.token('not-a-valid-contract')).toThrow(/C-address/);
  });

  it('should reject empty token address', () => {
    const builder = new StreamBuilder();
    expect(() => builder.token('')).toThrow(/non-empty/);
  });

  it('should accept valid sender (G-address)', () => {
    const builder = new StreamBuilder();
    expect(() => builder.sender('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN')).not.toThrow();
  });

  it('should reject invalid sender address', () => {
    const builder = new StreamBuilder();
    expect(() => builder.sender('not-a-valid-sender')).toThrow(/public key/);
  });

  it('should accept valid recipient (G-address)', () => {
    const builder = new StreamBuilder();
    expect(() => builder.recipient('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN')).not.toThrow();
  });

  it('should reject invalid recipient address', () => {
    const builder = new StreamBuilder();
    expect(() => builder.recipient('not-a-valid-recipient')).toThrow(/public key/);
  });
});
