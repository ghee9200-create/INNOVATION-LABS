export const inquiryAddDays = (dateKey, count) => {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + count));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
};

export const isInquiryExclusivePlan = (plan) => (
  plan === true || String(plan || '').trim().toLowerCase() === 'exclusive'
);

export const isInquiryDateBookable = (dateKey, today, subscriptionOrExclusive) => {
  const tomorrow = inquiryAddDays(today, 1);
  return dateKey !== tomorrow || isInquiryExclusivePlan(subscriptionOrExclusive);
};
