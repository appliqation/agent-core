import { describe, it, expect } from 'vitest';
import { classifyClick } from './destructiveActionGate.js';

describe('classifyClick — destructive-action gate', () => {
  const blockedLabels = [
    'Pay now',
    'Pay',
    'Purchase',
    'Place order',
    'Place the order',
    'Buy now',
    'Checkout',
    'Confirm and pay',
    'Confirm purchase',
    'Confirm order',
    'Confirm delete',
    'Confirm and remove',
    'Delete',
    'Remove account',
    'Remove everything',
    'Send message',
    'Send email',
    'Send invite',
    'Publish',
    'Submit order',
    'Submit payment',
    'Unsubscribe',
    'Cancel subscription',
    'Cancel account',
  ];

  it.each(blockedLabels)('blocks "%s"', (label) => {
    const result = classifyClick({ label, tag: 'button' });
    expect(result).not.toBeNull();
    expect(result?.ok).toBe(false);
    expect(result?.text).toMatch(/Blocked/);
  });

  it('is case-insensitive', () => {
    expect(classifyClick({ label: 'DELETE', tag: 'button' })).not.toBeNull();
    expect(classifyClick({ label: 'delete', tag: 'button' })).not.toBeNull();
    expect(classifyClick({ label: 'DeLeTe', tag: 'button' })).not.toBeNull();
  });

  const safeLabels = [
    'Save',
    'Continue',
    'Next',
    'Add to cart', // intermediate action, not the final destructive step
    'Back',
    'Cancel', // bare "cancel" with no subscription/account object is not blocked
    'Confirm', // bare "confirm" with no destructive object is not blocked
    'View details',
    'Search',
    'Login',
    'Submit', // bare "submit" (not "submit order"/"submit payment") is not blocked
  ];

  it.each(safeLabels)('does not block "%s"', (label) => {
    expect(classifyClick({ label, tag: 'button' })).toBeNull();
  });

  it('respects word boundaries — does not false-positive on a substring match', () => {
    // "Undelete" contains "delete" but not as a standalone word.
    expect(classifyClick({ label: 'Undelete', tag: 'button' })).toBeNull();
  });

  it('blocks mailto: links regardless of label', () => {
    const result = classifyClick({ label: 'Contact us', tag: 'a', href: 'mailto:someone@example.com' });
    expect(result).not.toBeNull();
    expect(result?.text).toMatch(/external contact link/);
  });

  it('blocks tel: and sms: links', () => {
    expect(classifyClick({ label: 'Call', tag: 'a', href: 'tel:+15551234567' })).not.toBeNull();
    expect(classifyClick({ label: 'Text', tag: 'a', href: 'sms:+15551234567' })).not.toBeNull();
  });

  it('does not block a regular http(s) link', () => {
    expect(classifyClick({ label: 'Learn more', tag: 'a', href: 'https://example.com/about' })).toBeNull();
  });
});
