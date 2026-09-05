import { describe, it, expect } from 'vitest';
import { StreamBuilder } from '../builder.js';
import { ValidationError, isConduitError } from '../errors.js';

const VALID_TOKEN = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const VALID_SENDER = 'GAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQDZ7H';
const VALID_RECIPIENT = 'GABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEJXA';

describe('StreamBuilder: aggregate validation errors (#631)', () => {
  it('aggregates multiple invalid fields into a single ValidationError with .issues[]', () => {
    const builder = new StreamBuilder()
      .token('invalid-token-contract')
      .sender('invalid-sender-key')
      .recipient('invalid-recipient-key')
      .amount(-500)
      .ratePerSecond(0);

    let caughtError: unknown;
    try {
      builder.build();
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ValidationError);
    expect(isConduitError(caughtError)).toBe(true);

    const validationError = caughtError as ValidationError;
    expect(validationError.name).toBe('ValidationError');
    expect(validationError.issues).toHaveLength(5);

    const fields = validationError.issues.map((i) => i.field);
    expect(fields).toContain('token');
    expect(fields).toContain('sender');
    expect(fields).toContain('recipient');
    expect(fields).toContain('amount');
    expect(fields).toContain('ratePerSecond');

    // Individual issue messages must detail each invalid field
    const tokenIssue = validationError.issues.find((i) => i.field === 'token');
    expect(tokenIssue?.message).toContain('C-address');

    const senderIssue = validationError.issues.find((i) => i.field === 'sender');
    expect(senderIssue?.message).toContain('public key');

    const recipientIssue = validationError.issues.find((i) => i.field === 'recipient');
    expect(recipientIssue?.message).toContain('public key');

    const amountIssue = validationError.issues.find((i) => i.field === 'amount');
    expect(amountIssue?.message).toContain('positive finite number');

    const rateIssue = validationError.issues.find((i) => i.field === 'ratePerSecond');
    expect(rateIssue?.message).toContain('positive finite number');
  });

  it('aggregates all missing required fields into .issues[] when none are provided', () => {
    const builder = new StreamBuilder();

    let caughtError: unknown;
    try {
      builder.build();
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ValidationError);
    const validationError = caughtError as ValidationError;

    expect(validationError.issues).toHaveLength(4);
    const missingFields = validationError.issues.map((i) => i.field);
    expect(missingFields).toEqual(['token', 'sender', 'recipient', 'amount']);

    for (const issue of validationError.issues) {
      expect(issue.message).toMatch(/^Missing required parameter:/);
    }

    expect(validationError.message).toContain('Missing required parameters for StreamBuilder');
  });

  it('aggregates mixed missing and invalid fields into .issues[]', () => {
    // token is invalid, amount is invalid, sender and recipient are missing
    const builder = new StreamBuilder()
      .token('invalid-contract-format')
      .amount(-10);

    let caughtError: unknown;
    try {
      builder.build();
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ValidationError);
    const validationError = caughtError as ValidationError;

    expect(validationError.issues).toHaveLength(4);
    const issueFields = validationError.issues.map((i) => i.field);
    expect(issueFields).toContain('token');
    expect(issueFields).toContain('sender');
    expect(issueFields).toContain('recipient');
    expect(issueFields).toContain('amount');

    expect(validationError.message).toContain('Missing required parameters for StreamBuilder');
    expect(validationError.message).toContain('Invalid StreamBuilder parameter');
  });

  it('exposes a validate() method that returns issues without throwing', () => {
    const builder = new StreamBuilder()
      .token('invalid-contract')
      .amount(100);

    // validate() returns the list of issues for non-throwing inspection
    const issues = builder.validate();
    expect(issues.length).toBeGreaterThan(0);

    const fields = issues.map((i) => i.field);
    expect(fields).toContain('token');
    expect(fields).toContain('sender');
    expect(fields).toContain('recipient');
  });

  it('returns an empty array from validate() when all required parameters are valid', () => {
    const builder = new StreamBuilder()
      .token(VALID_TOKEN)
      .sender(VALID_SENDER)
      .recipient(VALID_RECIPIENT)
      .amount(1000);

    expect(builder.validate()).toEqual([]);
    expect(() => builder.build()).not.toThrow();
  });

  it('validates optional startTime, endTime, and clawbackEnabled constraints in aggregate', () => {
    const pastTime = 1000; // Unix timestamp 1000 is far in the past
    const builder = new StreamBuilder()
      .token(VALID_TOKEN)
      .sender(VALID_SENDER)
      .recipient(VALID_RECIPIENT)
      .amount(1000)
      .startTime(pastTime)
      .endTime(500) // endTime <= startTime
      .clawbackEnabled('not-a-boolean' as unknown as boolean);

    let caughtError: unknown;
    try {
      builder.build();
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ValidationError);
    const validationError = caughtError as ValidationError;

    const fields = validationError.issues.map((i) => i.field);
    expect(fields).toContain('startTime');
    expect(fields).toContain('endTime');
    expect(fields).toContain('clawbackEnabled');
  });

  it('throws ValidationError from toContractArgs() when ratePerSecond is missing', () => {
    const builder = new StreamBuilder()
      .token(VALID_TOKEN)
      .sender(VALID_SENDER)
      .recipient(VALID_RECIPIENT)
      .amount(1000);

    let caughtError: unknown;
    try {
      builder.toContractArgs();
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ValidationError);
    const validationError = caughtError as ValidationError;
    expect(validationError.issues).toHaveLength(1);
    expect(validationError.issues[0]?.field).toBe('ratePerSecond');
    expect(validationError.message).toContain('ratePerSecond is required');
  });

  it('allows complete method chaining without premature exceptions', () => {
    // Calling setters with invalid values must not throw before build()
    expect(() => {
      const builder = new StreamBuilder();
      builder
        .token('bad-1')
        .sender('bad-2')
        .recipient('bad-3')
        .amount(-1)
        .ratePerSecond(-2)
        .startTime(-3)
        .endTime(-4)
        .clawbackEnabled(123 as unknown as boolean);
    }).not.toThrow();
  });

  it('ValidationError formats single issue message cleanly', () => {
    const singleIssue = new ValidationError([{ field: 'amount', message: 'amount must be positive' }]);
    expect(singleIssue.message).toBe('amount must be positive');
    expect(singleIssue.issues).toHaveLength(1);
  });

  it('ValidationError formats multiple issues into a structured summary', () => {
    const multiIssue = new ValidationError([
      { field: 'token', message: 'invalid token' },
      { field: 'sender', message: 'invalid sender' },
    ]);
    expect(multiIssue.message).toContain('Validation failed with 2 issues:');
    expect(multiIssue.message).toContain('- [token] invalid token');
    expect(multiIssue.message).toContain('- [sender] invalid sender');
  });
});
