"""infra/ must describe what the code expects, or a deploy would pass review and fail at runtime."""

import json
from pathlib import Path

from voice_sidecar.records import table_definition

INFRA = Path(__file__).resolve().parent.parent / "infra"


def _cfn_table():
    t = json.loads((INFRA / "voices-table.cfn.json").read_text())
    return t["Resources"]["VoicesTable"]["Properties"]


def test_the_cloudformation_table_matches_the_definition_the_code_uses():
    code, cfn = table_definition("x"), _cfn_table()
    assert cfn["BillingMode"] == code["BillingMode"]
    key = lambda l: sorted((a["AttributeName"], a.get("AttributeType") or a.get("KeyType")) for a in l)
    assert key(cfn["AttributeDefinitions"]) == key(code["AttributeDefinitions"])
    assert key(cfn["KeySchema"]) == key(code["KeySchema"])
    cg, kg = cfn["GlobalSecondaryIndexes"][0], code["GlobalSecondaryIndexes"][0]
    assert cg["IndexName"] == kg["IndexName"] == "gsi1" and key(cg["KeySchema"]) == key(kg["KeySchema"]) and cg["Projection"] == kg["Projection"]


def test_the_table_is_protected_and_the_audit_ttl_attribute_matches_the_code():
    cfn = _cfn_table()
    assert cfn["DeletionProtectionEnabled"] is True and cfn["PointInTimeRecoverySpecification"]["PointInTimeRecoveryEnabled"] is True
    assert cfn["SSESpecification"]["SSEEnabled"] is True and cfn["TimeToLiveSpecification"] == {"AttributeName": "ttl", "Enabled": True}
    whole = json.loads((INFRA / "voices-table.cfn.json").read_text())["Resources"]["VoicesTable"]
    assert whole["DeletionPolicy"] == "Retain"  # deleting the stack must not delete people's consent records


def test_the_example_iam_policy_is_least_privilege():
    pol = json.loads((INFRA / "iam-policy.example.json").read_text())
    for st in pol["Statement"]:
        assert st["Effect"] == "Allow"
        res = st["Resource"] if isinstance(st["Resource"], list) else [st["Resource"]]
        assert all(r != "*" and "*" not in r.split(":")[-1].replace("-*", "") for r in res), st["Sid"]  # no wildcard resources
        acts = st["Action"] if isinstance(st["Action"], list) else [st["Action"]]
        assert all(a not in ("dynamodb:*", "secretsmanager:*", "*") for a in acts), st["Sid"]
    actions = {a for st in pol["Statement"] for a in (st["Action"] if isinstance(st["Action"], list) else [st["Action"]])}
    assert "dynamodb:Scan" not in actions and "secretsmanager:PutSecretValue" not in actions and "dynamodb:DeleteTable" not in actions


def test_every_dynamodb_action_the_code_uses_is_in_the_policy():
    """If the store starts calling a new API, the policy Rajvir deploys must grow with it."""
    import re

    pkg = Path(__file__).resolve().parent.parent / "voice_sidecar"
    src = (pkg / "records.py").read_text() + (pkg / "users.py").read_text()
    used = set(re.findall(r"client\.(get_item|put_item|update_item|delete_item|query|scan|transact_write_items)\(", src))
    needs = {"get_item": "dynamodb:GetItem", "query": "dynamodb:Query", "update_item": "dynamodb:UpdateItem", "put_item": "dynamodb:PutItem", "delete_item": "dynamodb:DeleteItem", "scan": "dynamodb:Scan"}
    pol = json.loads((INFRA / "iam-policy.example.json").read_text())
    granted = {a for st in pol["Statement"] for a in (st["Action"] if isinstance(st["Action"], list) else [st["Action"]])}
    for u in used - {"transact_write_items"}:
        assert needs[u] in granted, f"{u} is used but {needs[u]} is not granted"
    if "transact_write_items" in used:  # a transaction needs the per-item permissions of each operation it contains
        assert {"dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"} <= granted
