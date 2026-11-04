const toPaise = (amount) => Math.round(Number(amount || 0) * 100);

export const getOrderItemQuantities = (item) => {
  const quantity = Math.max(0, Number(item?.quantity) || 0);
  const cancelledQuantity = Math.min(quantity, Math.max(0, Number(item?.cancelledQuantity) || 0));
  return { quantity, activeQuantity: quantity - cancelledQuantity, cancelledQuantity };
};

export const resolveCancellationItems = (order, requestedItems) => {
  const requestedByIndex = new Map(requestedItems.map((item) => [item.itemIndex, item.quantity]));
  if (requestedByIndex.size !== requestedItems.length) {
    throw Object.assign(new Error('A product was selected more than once.'), { status: 400 });
  }

  return [...requestedByIndex].map(([itemIndex, quantity]) => {
    const item = order.items[itemIndex];
    if (!item) throw Object.assign(new Error('A selected product was not found in this order.'), { status: 400 });
    if (item.cancellable === false) {
      throw Object.assign(new Error(`${item.name} is non-cancellable and cannot be cancelled by the customer.`), { status: 409 });
    }
    const remainingQuantity = getOrderItemQuantities(item).activeQuantity;
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > remainingQuantity) {
      throw Object.assign(new Error(`Only ${Math.max(0, remainingQuantity)} unit(s) of ${item.name} remain eligible for cancellation.`), { status: 409 });
    }
    return { itemIndex, item, quantity };
  });
};

export const calculateCancellationRefund = (order, selectedItems) => {
  const originalAmountPaise = Number(order.verifiedAmountPaidPaise ?? toPaise(order.total));
  const previousRefundedPaise = Number(order.cancellationRefundedPaise || 0);
  const previouslyDeductedPaise = Number(order.cancellationDeductionsPaise || 0);
  const totalNonRefundableChargesPaise = toPaise(order.deliveryCharge || 0)
    + toPaise(order.codingCharge || 0)
    + toPaise(order.buildingCharge || 0);
  const deductionsPaise = previouslyDeductedPaise > 0 ? 0 : totalNonRefundableChargesPaise;
  const itemAmounts = selectedItems.map(({ itemIndex, item, quantity }) => ({
    itemIndex,
    quantity,
    amountPaise: Number(item.unitPricePaise ?? toPaise(item.price)) * quantity,
  }));
  const grossCancelledPaise = itemAmounts.reduce((sum, item) => sum + item.amountPaise, 0);
  const orderSubtotalPaise = toPaise(order.subtotal || 0);
  const orderDiscountPaise = Number(order.discountAmountPaise || 0);
  const allocatedDiscountPaise = orderSubtotalPaise > 0
    ? Math.min(orderDiscountPaise, Math.round(orderDiscountPaise * grossCancelledPaise / orderSubtotalPaise))
    : 0;
  const eligibleProductAmountPaise = Math.max(0, grossCancelledPaise - allocatedDiscountPaise);
  const remainingRefundablePaise = Math.max(
    0,
    originalAmountPaise - previousRefundedPaise - previouslyDeductedPaise - deductionsPaise,
  );
  const amountPaise = Math.min(eligibleProductAmountPaise, remainingRefundablePaise);

  if (!Number.isSafeInteger(originalAmountPaise) || originalAmountPaise <= 0
    || !Number.isSafeInteger(totalNonRefundableChargesPaise) || totalNonRefundableChargesPaise < 0
    || !Number.isSafeInteger(grossCancelledPaise) || grossCancelledPaise < 0
    || !Number.isSafeInteger(amountPaise) || amountPaise < 0) {
    throw Object.assign(new Error('The paid order amount is not valid for cancellation.'), { status: 409 });
  }

  return {
    originalAmountPaise,
    totalNonRefundableChargesPaise,
    previouslyDeductedPaise,
    deductionsPaise,
    itemAmounts,
    grossCancelledPaise,
    allocatedDiscountPaise,
    amountPaise,
  };
};
