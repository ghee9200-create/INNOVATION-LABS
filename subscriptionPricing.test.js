import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSubscriptionDiscount } from './subscriptionPricing.js';

test('calculates the configured plan discount in paise', () => {
  assert.deepEqual(calculateSubscriptionDiscount('Starter', 10001), {
    plan: 'Starter', percentage: 0, amountPaise: 0,
  });
  assert.deepEqual(calculateSubscriptionDiscount('Medium', 10001), {
    plan: 'Medium', percentage: 3, amountPaise: 300,
  });
  assert.deepEqual(calculateSubscriptionDiscount('Premium', 10001), {
    plan: 'Premium', percentage: 2, amountPaise: 200,
  });
  assert.deepEqual(calculateSubscriptionDiscount('Plus', 10001), {
    plan: 'Plus', percentage: 3, amountPaise: 300,
  });
  assert.deepEqual(calculateSubscriptionDiscount('Pro', 10001), {
    plan: 'Pro', percentage: 2, amountPaise: 200,
  });
  assert.deepEqual(calculateSubscriptionDiscount('Exclusive', 10001), {
    plan: 'Exclusive', percentage: 4, amountPaise: 400,
  });
});

test('rounds to the nearest paise and rejects invalid amounts', () => {
  assert.equal(calculateSubscriptionDiscount('Exclusive', 13).amountPaise, 1);
  assert.throws(() => calculateSubscriptionDiscount('Starter', -1), TypeError);
});
