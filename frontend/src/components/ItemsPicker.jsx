import { money } from "../api.js";

// Pick inventory items and quantities. "available" (optional) is the
// availability list for the chosen dates, used to warn about double-booking.
export default function ItemsPicker({ inventory, value, onChange, available }) {
  const quantityOf = (id) => value.find((v) => v.inventoryItemId === id)?.quantity || 0;
  const set = (id, quantity) => {
    const rest = value.filter((v) => v.inventoryItemId !== id);
    onChange(quantity > 0 ? [...rest, { inventoryItemId: id, quantity }] : rest);
  };
  if (!inventory.length) return <p className="muted">No equipment is set up yet. Technicians add it on the Inventory page.</p>;
  return (
    <table className="tbl compact">
      <thead>
        <tr><th>Item</th><th>Cost each</th>{available && <th>Free</th>}<th>Quantity</th></tr>
      </thead>
      <tbody>
        {inventory.map((item) => {
          const free = available?.find((a) => a.Id === item.Id)?.Available;
          const qty = quantityOf(item.Id);
          return (
            <tr key={item.Id}>
              <td>{item.Name}</td>
              <td>{money(item.UnitCost)}</td>
              {available && <td className={free !== undefined && qty > free ? "error" : ""}>{free ?? "?"}</td>}
              <td>
                <input type="number" min="0" max="1000" className="qty" value={qty}
                  onChange={(e) => set(item.Id, Math.max(0, parseInt(e.target.value || "0", 10)))} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
