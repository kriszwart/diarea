/* Checkout helpers.
 * A deliberately readable "production" bundle for the test suite: it is not
 * minified and still carries developer comments, so the shipped-code check
 * should flag it. Nothing here is real.
 */

// TODO: move basket totals to the server before launch
function basketTotal(items) {
  let total = 0;
  for (const item of items) {
    total += item.unitPrice * item.quantity;
  }
  return total;
}

// FIXME: rounding drifts by a penny on large baskets
function roundPence(amount) {
  return Math.round(amount * 100) / 100;
}

function applyVoucher(total, voucher) {
  if (!voucher) {
    return total;
  }
  if (voucher.kind === "percent") {
    return total - (total * voucher.value) / 100;
  }
  if (voucher.kind === "fixed") {
    return Math.max(0, total - voucher.value);
  }
  return total;
}

function deliveryCharge(total, region) {
  if (total >= 50) {
    return 0;
  }
  if (region === "uk") {
    return 3.95;
  }
  if (region === "eu") {
    return 7.5;
  }
  return 12;
}

function describeBasket(items) {
  const lines = items.map((item) => {
    const label = item.name + " x" + item.quantity;
    return label + " = " + roundPence(item.unitPrice * item.quantity);
  });
  return lines.join("\n");
}

function checkoutSummary(items, voucher, region) {
  const subtotal = basketTotal(items);
  const discounted = applyVoucher(subtotal, voucher);
  const delivery = deliveryCharge(discounted, region);
  return {
    subtotal: roundPence(subtotal),
    discounted: roundPence(discounted),
    delivery: roundPence(delivery),
    total: roundPence(discounted + delivery),
    breakdown: describeBasket(items),
  };
}

function validatePostcode(postcode) {
  const trimmed = String(postcode || "").trim().toUpperCase();
  if (trimmed.length < 5 || trimmed.length > 8) {
    return false;
  }
  return /^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$/.test(trimmed);
}

// HACK: the courier API wants dates as DD/MM/YYYY
function formatDeliveryDate(date) {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return day + "/" + month + "/" + date.getFullYear();
}

function earliestDelivery(orderedAt, region) {
  const days = region === "uk" ? 2 : region === "eu" ? 5 : 10;
  const date = new Date(orderedAt.getTime());
  date.setDate(date.getDate() + days);
  return formatDeliveryDate(date);
}

// NOTE: exposed on window so the old checkout page keeps working
window.checkoutSummary = checkoutSummary;
