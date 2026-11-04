export const SUBSCRIPTION_DISCOUNT_PERCENT = Object.freeze({
  Starter: 0,
  Medium: 3,
  Premium: 2,
  Exclusive: 4,
  Plus: 3,
  Pro: 2,
});

export const calculateSubscriptionDiscount = (plan, amountPaise) => {
  const percentage = SUBSCRIPTION_DISCOUNT_PERCENT[plan] ?? 0;
  const eligibleAmountPaise = Number(amountPaise);
  if (!Number.isSafeInteger(eligibleAmountPaise) || eligibleAmountPaise < 0) {
    throw new TypeError('Subscription discount amount must be a non-negative integer number of paise.');
  }
  return {
    plan: SUBSCRIPTION_DISCOUNT_PERCENT[plan] == null ? 'Starter' : plan,
    percentage,
    amountPaise: Math.floor((eligibleAmountPaise * percentage + 50) / 100),
  };
};
