// Dollar amounts for history lines, like $1,250.00.
const money = (value) => Number(value || 0).toLocaleString("en-US", { style: "currency", currency: "USD" });

module.exports = { money };
