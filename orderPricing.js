const toPaise = (amount) => Math.round(Number(amount || 0) * 100);
const BUILDING_SERVICE_PRICE_PAISE = 120000;

export const calculateOrder = (safeItems, service = 'parts') => {
  const subtotalPaise = safeItems.reduce((sum, item) => sum + toPaise(item.price) * item.quantity, 0);
  const physicalItems = safeItems.filter((item) => !item.discountOfferId);
  const physicalSubtotalPaise = physicalItems.reduce((sum, item) => sum + toPaise(item.price) * item.quantity, 0);
  const itemCount = physicalItems.reduce((sum, item) => sum + item.quantity, 0);
  const codingChargePaise = itemCount && ['coding', 'full'].includes(service) ? toPaise(1000) : 0;
  const buildingChargePaise = itemCount && ['building', 'full'].includes(service)
    ? BUILDING_SERVICE_PRICE_PAISE
    : 0;
  const deliveryChargePaise = physicalSubtotalPaise >= toPaise(500)
    ? 0
    : physicalSubtotalPaise > 0 ? toPaise(40) : 0;
  return {
    subtotalPaise,
    codingChargePaise,
    buildingChargePaise,
    deliveryChargePaise,
    totalPaise: subtotalPaise + codingChargePaise + buildingChargePaise + deliveryChargePaise,
  };
};
