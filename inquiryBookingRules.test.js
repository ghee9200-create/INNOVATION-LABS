import assert from 'node:assert/strict';
import test from 'node:test';
import { inquiryAddDays, isInquiryDateBookable, isInquiryExclusivePlan } from './inquiryBookingRules.js';

test('reserves exactly tomorrow for Exclusive subscribers', () => {
  const today = '2026-11-04';
  assert.equal(inquiryAddDays(today, 1), '2026-11-05');
  assert.equal(isInquiryDateBookable('2026-11-05', today, false), false);
  assert.equal(isInquiryDateBookable('2026-11-05', today, true), true);
  assert.equal(isInquiryDateBookable('2026-11-06', today, false), true);
  assert.equal(isInquiryDateBookable('2026-11-07', today, false), true);
  assert.equal(isInquiryDateBookable('2026-11-06', today, 'Starter'), true);
  assert.equal(isInquiryDateBookable('2026-11-05', today, 'Medium'), false);
  assert.equal(isInquiryDateBookable('2026-11-05', today, 'Premium'), false);
  assert.equal(isInquiryDateBookable('2026-11-05', today, 'Exclusive'), true);
  assert.equal(isInquiryExclusivePlan('Exclusive'), true);
  assert.equal(isInquiryExclusivePlan('Premium'), false);
});
