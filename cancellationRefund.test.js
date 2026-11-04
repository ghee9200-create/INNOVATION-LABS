import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateCancellationRefund, getOrderItemQuantities } from './cancellationRefund.js';

const createOrder = (overrides = {}) => ({
  items: [{ name: 'LEDs', price: 20, unitPricePaise: 2000, quantity: 1 }],
  subtotal: 20,
  total: 60,
  verifiedAmountPaidPaise: 6000,
  deliveryCharge: 40,
  codingCharge: 0,
  buildingCharge: 0,
  discountAmountPaise: 0,
  cancellationDeductionsPaise: 0,
  cancellationRefundedPaise: 0,
  ...overrides,
});

test('refunds the product amount after deducting delivery once', () => {
  const order = createOrder();
  const result = calculateCancellationRefund(order, [{ itemIndex: 0, item: order.items[0], quantity: 1 }]);

  assert.equal(result.originalAmountPaise, 6000);
  assert.equal(result.deductionsPaise, 4000);
  assert.equal(result.amountPaise, 2000);
});

test('does not create a positive refund when charges consume the paid amount', () => {
  const order = createOrder({ verifiedAmountPaidPaise: 4000, total: 40, discountAmountPaise: 2000 });
  const result = calculateCancellationRefund(order, [{ itemIndex: 0, item: order.items[0], quantity: 1 }]);

  assert.equal(result.amountPaise, 0);
});

test('deducts the order charges only once across partial cancellations', () => {
  const items = [
    { name: 'LEDs', price: 10, unitPricePaise: 1000, quantity: 1 },
    { name: 'Resistor', price: 10, unitPricePaise: 1000, quantity: 1 },
  ];
  const order = createOrder({
    items,
    subtotal: 20,
    deliveryCharge: 40,
    cancellationDeductionsPaise: 4000,
    cancellationRefundedPaise: 1000,
  });
  const result = calculateCancellationRefund(order, [{ itemIndex: 1, item: items[1], quantity: 1 }]);

  assert.equal(result.deductionsPaise, 0);
  assert.equal(result.amountPaise, 1000);
});

test('excludes non-cancellable products and allocates discounts proportionally', () => {
  const items = [
    { name: 'LEDs', price: 20, unitPricePaise: 2000, quantity: 1 },
    { name: 'Custom item', price: 10, unitPricePaise: 1000, quantity: 1, cancellable: false },
  ];
  const order = createOrder({
    items,
    subtotal: 30,
    total: 66,
    verifiedAmountPaidPaise: 6600,
    deliveryCharge: 40,
    discountAmountPaise: 400,
  });
  const result = calculateCancellationRefund(order, [{ itemIndex: 0, item: items[0], quantity: 1 }]);

  assert.equal(result.allocatedDiscountPaise, 267);
  assert.equal(result.amountPaise, 1733);
});

test('splits active and cancelled quantities without changing the saved order quantity', () => {
  const item = { quantity: 3, cancelledQuantity: 1 };
  const result = getOrderItemQuantities(item);

  assert.deepEqual(result, { quantity: 3, activeQuantity: 2, cancelledQuantity: 1 });
  assert.equal(item.quantity, 3);
});
