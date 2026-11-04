const INDIA_TIME_ZONE = 'Asia/Kolkata';

const getIndiaDateParts = (date) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: INDIA_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
};

export const formatEstimatedDelivery = (estimatedDelivery, now = new Date()) => {
  if (!estimatedDelivery) return null;
  const deliveryDate = new Date(estimatedDelivery);
  const currentDate = new Date(now);
  if (Number.isNaN(deliveryDate.getTime()) || Number.isNaN(currentDate.getTime())) return null;

  const deliveryParts = getIndiaDateParts(deliveryDate);
  const currentParts = getIndiaDateParts(currentDate);
  const deliveryDay = Date.UTC(deliveryParts.year, deliveryParts.month - 1, deliveryParts.day);
  const currentDay = Date.UTC(currentParts.year, currentParts.month - 1, currentParts.day);
  const daysRemaining = Math.round((deliveryDay - currentDay) / 86_400_000);

  if (daysRemaining >= 0 && daysRemaining <= 7) {
    return `ARRIVING ON ${new Intl.DateTimeFormat('en-IN', {
      timeZone: INDIA_TIME_ZONE,
      weekday: 'long',
    }).format(deliveryDate).toUpperCase()}`;
  }

  return `ARRIVING ON ${new Intl.DateTimeFormat('en-IN', {
    timeZone: INDIA_TIME_ZONE,
    day: 'numeric',
    month: 'long',
  }).format(deliveryDate).toUpperCase()}`;
};
