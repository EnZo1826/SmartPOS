"""
EnZo POS — Frappe/ERPNext Sync App
===================================
App: pos_sync
Install: bench get-app pos_sync [repo]
         bench install-app pos_sync

File: pos_sync/api.py
"""

import frappe
from frappe import _
from frappe.utils import now_datetime, get_datetime, cint
import json


# ─────────────────────────────────────────────────────────────────────
#  HEALTH CHECK
# ─────────────────────────────────────────────────────────────────────
@frappe.whitelist(allow_guest=False)
def health():
    """GET /api/method/pos_sync.health"""
    return {
        "status": "ok",
        "version": "2.0",
        "server_time": str(now_datetime()),
        "site": frappe.local.site
    }


# ─────────────────────────────────────────────────────────────────────
#  PUSH BATCH
# ─────────────────────────────────────────────────────────────────────
@frappe.whitelist(allow_guest=False)
def push_batch(batch=None):
    """
    POST /api/method/pos_sync.push_batch
    Body: { "batch": [ { outbox_id, entity_type, entity_uuid, operation, payload, device_id }, ... ] }

    Processes each item idempotently.
    Returns: { "processed": [...], "failed": [...] }
    """
    if isinstance(batch, str):
        batch = json.loads(batch)

    processed = []
    failed = []

    for item in (batch or []):
        try:
            entity_type = item.get("entity_type")
            entity_uuid = item.get("entity_uuid")
            operation = item.get("operation")
            payload = item.get("payload") or {}
            outbox_id = item.get("outbox_id")
            device_id = item.get("device_id", "")

            if entity_type == "order":
                server_id = _handle_order(entity_uuid, operation, payload, device_id)
            elif entity_type == "refund":
                server_id = _handle_refund(entity_uuid, operation, payload, device_id)
            elif entity_type == "shift":
                server_id = _handle_shift(entity_uuid, operation, payload, device_id)
            elif entity_type == "cash_event":
                server_id = _handle_cash_event(entity_uuid, operation, payload, device_id)
            else:
                raise ValueError(f"Unknown entity_type: {entity_type}")

            processed.append({
                "outbox_id": outbox_id,
                "entity_uuid": entity_uuid,
                "server_id": server_id,
                "status": "ok"
            })
            frappe.db.commit()

        except Exception as e:
            frappe.db.rollback()
            failed.append({
                "outbox_id": item.get("outbox_id"),
                "entity_uuid": item.get("entity_uuid"),
                "error": str(e)
            })
            frappe.log_error(frappe.get_traceback(), f"POS Sync Error: {item.get('entity_type')}")

    return {
        "processed": processed,
        "failed": failed
    }


def _handle_order(uuid, operation, payload, device_id):
    """Idempotently create/update a POS Invoice or custom Offline POS Order."""
    order_data = payload.get("order", {})
    items = payload.get("items", [])
    payments = payload.get("payments", [])

    # Check if already synced (idempotency by uuid)
    existing = frappe.db.get_value("Offline POS Order", {"client_uuid": uuid}, "name")

    if existing and operation == "create":
        # Already exists — return existing server ID (idempotent)
        return existing

    if not existing:
        # Create new document
        doc = frappe.new_doc("Offline POS Order")
        doc.client_uuid = uuid
        doc.device_id = device_id
        doc.store_id = order_data.get("shift_id", "")
        doc.cashier = order_data.get("cashier_name", "")
        doc.customer = order_data.get("customer", "Walk-in")
        doc.order_date = order_data.get("created_at_local", str(now_datetime()))
        doc.subtotal = order_data.get("subtotal", 0)
        doc.discount_amount = order_data.get("discount_amount", 0)
        doc.tax_amount = order_data.get("tax_amount", 0)
        doc.grand_total = order_data.get("total", 0)
        doc.status = order_data.get("status", "Completed")

        # Order items
        for item in items:
            doc.append("items", {
                "item_code": item.get("product_uuid"),
                "item_name": item.get("product_name"),
                "qty": item.get("qty"),
                "rate": item.get("unit_price"),
                "discount_percentage": item.get("line_discount", 0),
                "amount": item.get("line_total")
            })

        # Payments
        for pmt in payments:
            doc.append("payments", {
                "mode_of_payment": pmt.get("method", "Cash").title(),
                "amount": pmt.get("amount")
            })

        # Generate server-side receipt number
        doc.receipt_number = frappe.model.naming.make_autoname("POS-.YYYY.-.MM.-.#####")
        doc.insert(ignore_permissions=True)

        return doc.name
    else:
        # Update existing
        doc = frappe.get_doc("Offline POS Order", existing)
        doc.status = order_data.get("status", doc.status)
        doc.save(ignore_permissions=True)
        return doc.name


def _handle_refund(uuid, operation, payload, device_id):
    """Process a refund against an existing order."""
    existing = frappe.db.get_value("Offline POS Refund", {"client_uuid": uuid}, "name")
    if existing:
        return existing

    doc = frappe.new_doc("Offline POS Refund")
    doc.client_uuid = uuid
    doc.device_id = device_id
    doc.order_uuid = payload.get("order_uuid")
    doc.reason = payload.get("reason", "")
    doc.amount = payload.get("amount", 0)
    doc.status = payload.get("status", "Processed")
    doc.refund_date = payload.get("created_at_local", str(now_datetime()))

    # Link to original order
    original = frappe.db.get_value("Offline POS Order", {"client_uuid": doc.order_uuid}, "name")
    if original:
        doc.original_order = original

    doc.insert(ignore_permissions=True)

    # Update original order status
    if original:
        frappe.db.set_value("Offline POS Order", original, "status", "Refunded")

    return doc.name


def _handle_shift(uuid, operation, payload, device_id):
    """Handle shift open/close records."""
    existing = frappe.db.get_value("Offline POS Shift", {"client_uuid": uuid}, "name")
    if existing:
        # Update shift close info if available
        if payload.get("status") == "closed":
            frappe.db.set_value("Offline POS Shift", existing, {
                "status": "Closed",
                "closed_at": payload.get("closed_at"),
                "expected_cash": payload.get("expected_cash"),
                "counted_cash": payload.get("counted_cash"),
                "variance": payload.get("variance")
            })
        return existing

    doc = frappe.new_doc("Offline POS Shift")
    doc.client_uuid = uuid
    doc.device_id = device_id
    doc.cashier = payload.get("cashier_id", "")
    doc.opened_at = payload.get("opened_at", str(now_datetime()))
    doc.float_amount = payload.get("float_amount", 0)
    doc.status = "Open" if payload.get("status") == "open" else "Closed"
    doc.insert(ignore_permissions=True)
    return doc.name


def _handle_cash_event(uuid, operation, payload, device_id):
    """Handle cash in/out events."""
    existing = frappe.db.get_value("Offline POS Cash Event", {"client_uuid": uuid}, "name")
    if existing:
        return existing

    doc = frappe.new_doc("Offline POS Cash Event")
    doc.client_uuid = uuid
    doc.device_id = device_id
    doc.shift_id = payload.get("shift_id")
    doc.event_type = "Cash In" if payload.get("type") == "in" else "Cash Out"
    doc.amount = payload.get("amount", 0)
    doc.reason = payload.get("reason", "")
    doc.event_date = payload.get("created_at_local", str(now_datetime()))
    doc.insert(ignore_permissions=True)
    return doc.name


# ─────────────────────────────────────────────────────────────────────
#  PULL CATALOG
# ─────────────────────────────────────────────────────────────────────
@frappe.whitelist(allow_guest=False)
def pull_catalog(since="1970-01-01T00:00:00Z"):
    """
    GET /api/method/pos_sync.pull_catalog?since=...
    Returns products and categories updated since the given timestamp.
    """
    since_dt = get_datetime(since)

    # Fetch items from ERPNext Item master
    items = frappe.get_all(
        "Item",
        filters=[
            ["modified", ">=", since_dt],
            ["is_sales_item", "=", 1]
        ],
        fields=["name", "item_name", "item_group", "standard_rate",
                "barcode", "modified", "disabled", "description"],
        order_by="modified desc",
        limit=500
    )

    products = []
    for item in items:
        # Get barcode
        barcode = None
        barcodes = frappe.get_all("Item Barcode", filters={"parent": item.name}, fields=["barcode"], limit=1)
        if barcodes:
            barcode = barcodes[0].barcode

        # Get tax rate
        tax_rate = _get_item_tax_rate(item.name)

        products.append({
            "uuid": item.name,  # Using ERPNext item code as UUID
            "sku": item.name,
            "barcode": barcode,
            "name": item.item_name,
            "category": item.item_group,
            "price": item.standard_rate or 0,
            "tax_rate": tax_rate,
            "active": 0 if item.disabled else 1,
            "emoji": "📦",
            "track_stock": True,
            "stock": _get_stock_qty(item.name),
            "updated_at": str(item.modified)
        })

    # Fetch item groups as categories
    groups = frappe.get_all(
        "Item Group",
        filters=[["modified", ">=", since_dt], ["is_group", "=", 0]],
        fields=["name", "modified"]
    )
    categories = [{"uuid": g.name, "name": g.name} for g in groups]

    return {
        "products": products,
        "categories": categories,
        "updated_at": str(now_datetime()),
        "count": len(products)
    }


def _get_item_tax_rate(item_code):
    """Fetch GST/VAT rate for an item."""
    try:
        tax_template = frappe.db.get_value("Item Tax", {"parent": item_code}, "item_tax_template")
        if tax_template:
            rate = frappe.db.get_value("Item Tax Template Detail",
                                        {"parent": tax_template}, "tax_rate")
            return (rate or 0) / 100
    except:
        pass
    return 0.15  # Default 15%


def _get_stock_qty(item_code):
    """Get current stock quantity."""
    try:
        qty = frappe.db.get_value(
            "Bin",
            {"item_code": item_code},
            "actual_qty",
            order_by="actual_qty desc"
        ) or 0
        return float(qty)
    except:
        return 999


# ─────────────────────────────────────────────────────────────────────
#  DOCTYPES TO CREATE (hooks.py reference)
# ─────────────────────────────────────────────────────────────────────
"""
Required custom DocTypes in your Frappe app:

1. Offline POS Order
   Fields: client_uuid, device_id, store_id, cashier, customer,
           order_date, subtotal, discount_amount, tax_amount,
           grand_total, status, receipt_number
   Child: items (item_code, item_name, qty, rate, discount_percentage, amount)
   Child: payments (mode_of_payment, amount)

2. Offline POS Refund
   Fields: client_uuid, device_id, order_uuid, original_order (Link: Offline POS Order),
           reason, amount, status, refund_date

3. Offline POS Shift
   Fields: client_uuid, device_id, cashier, opened_at, closed_at,
           float_amount, expected_cash, counted_cash, variance, status

4. Offline POS Cash Event
   Fields: client_uuid, device_id, shift_id, event_type (Cash In/Cash Out),
           amount, reason, event_date

All DocTypes should have autoname: field:client_uuid (or use hash naming)
"""
