"""Offline behavioral checks with synthetic artifacts and usage; no model calls."""

import copy
import json
from pathlib import Path
import tempfile
import unittest

import package_evidence as pack


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        texts = {"target": "EXACT TARGET\n", "definitions": "ALL DEFINITIONS\n",
                 "hypotheses": "ALL HYPOTHESES\n", "lemma": "COMPLETE LEMMA BODY\n",
                 "proof": "COMPLETE PROOF BODY\n", "objection": "UNRESOLVED OBJECTION\n",
                 "history": "UNRELATED HISTORY\n", "toolchain": "fixed-toolchain\n",
                 "policy": "fixed-validation-policy\n"}
        graph = {"target": ["definitions", "hypotheses"], "proof": ["target", "lemma"],
                 "lemma": ["definitions"], "objection": ["proof"]}
        for name, text in texts.items():
            (self.root / f"{name}.txt").write_text(text)
        (self.root / "role.txt").write_text("Trusted reviewer role contract.\n")
        self.spec = {
            "schema_version": "evidence-package-spec/v1", "case_id": "synthetic-case",
            "claim_id": "synthetic-target", "role_contract": "role.txt",
            "target_ids": ["target"], "proof_ids": ["proof"],
            "context_ids": ["definitions", "hypotheses"], "review_roots": [],
            "artifacts": {name: {"path": f"{name}.txt", "kind": "fixture",
                                  "dependencies": graph.get(name, [])} for name in texts},
            "open_objections": [{"id": "OBJ-1", "status": "accepted", "evidence_ids": ["objection"]}],
            "environment": {"toolchain": {"version": "synthetic-1", "binary_sha256": "a" * 64},
                            "libraries": {"core": "synthetic-core-1"}, "artifact_ids": ["toolchain"]},
            "verification_policy": {"version": "synthetic-policy-1", "artifact_ids": ["policy"]},
            "resource_boundary": {"seconds": 60, "memory_mb": 128},
            "attempt_strategy": {"version": "synthetic-attempt-1"},
            "dynamic": {"round": 1}}
        self.count = 0

    def build(self, spec=None, previous=None, limit=None):
        self.count += 1
        path = self.root / f"spec-{self.count}.json"
        path.write_bytes(pack.canonical(self.spec if spec is None else spec))
        out = self.root / f"package-{self.count}"
        pack.build(self.root, path, out, previous, limit)
        return out

    def read(self, package, filename):
        return json.loads((package / filename).read_bytes())

    def test_full_archive_scoped_payload_and_stable_prefix(self):
        first = self.build()
        self.spec["dynamic"]["round"] = 2
        (self.root / "proof.txt").write_text("REPAIRED PROOF FULL BODY\n")
        (self.root / "history.txt").write_text("UNRELATED HISTORY CHANGED\n")
        second = self.build(previous=first)
        self.assertEqual((first / "prefix.txt").read_bytes(), (second / "prefix.txt").read_bytes())
        messages = self.read(second, "messages.json")
        payload = messages[1]["content"]
        for text in ("EXACT TARGET", "ALL DEFINITIONS", "ALL HYPOTHESES",
                     "COMPLETE LEMMA BODY", "REPAIRED PROOF FULL BODY", "UNRESOLVED OBJECTION"):
            self.assertIn(text, payload)
        self.assertNotIn("UNRELATED HISTORY", payload)
        self.assertNotIn("fixed-validation-policy", payload)
        self.assertIn('"dependencies":["definitions"]', payload)
        manifest = pack.verify(second)
        self.assertIn("history", manifest["not_selected_ids"])
        self.assertEqual(pack.bound(second, manifest["artifacts"]["history"]["blob"]).read_text(),
                         "UNRELATED HISTORY CHANGED\n")
        self.assertEqual(messages[0], self.read(first, "messages.json")[0])
        self.assertEqual(manifest["status"], "packaged_unverified")

    def test_transitive_change_invalidates_and_traces_dependents(self):
        first = self.build()
        (self.root / "definitions.txt").write_text("CHANGED DEFINITION\n")
        second = self.build(previous=first)
        self.assertNotEqual(self.read(first, "reuse.json")["reuse_key"],
                            self.read(second, "reuse.json")["reuse_key"])
        self.assertTrue({"definitions", "target", "lemma", "proof", "objection"}.issubset(
            self.read(second, "delta.json")["affected_ids"]))
        self.assertIn("CHANGED DEFINITION", (second / "changes.diff").read_text())

    def test_removed_assumption_is_visible_and_policy_can_be_requested(self):
        first = self.build()
        del self.spec["artifacts"]["hypotheses"]
        self.spec["context_ids"].remove("hypotheses")
        self.spec["artifacts"]["target"]["dependencies"].remove("hypotheses")
        self.spec["review_roots"] = ["policy"]
        second = self.build(previous=first)
        payload = self.read(second, "messages.json")[1]["content"]
        self.assertIn("ALL HYPOTHESES", payload)  # Prior assumption deletion must be reviewed.
        self.assertIn("fixed-validation-policy", payload)
        changes = self.read(second, "delta.json")["review_dependency_changes"]
        self.assertEqual(changes["target"]["before"], ["definitions", "hypotheses"])
        self.assertEqual(changes["target"]["after"], ["definitions"])

    def test_binding_axes_and_failure_boundary(self):
        baseline = self.read(self.build(), "reuse.json")
        for axis in ("toolchain", "libraries", "policy", "dependencies", "target", "proof"):
            spec = copy.deepcopy(self.spec)
            if axis == "toolchain":
                spec["environment"]["toolchain"]["version"] = "synthetic-2"
            elif axis == "libraries":
                spec["environment"]["libraries"]["core"] = "synthetic-core-2"
            elif axis == "policy":
                spec["verification_policy"]["version"] = "synthetic-policy-2"
            elif axis == "dependencies":
                spec["artifacts"]["proof"]["dependencies"].append("hypotheses")
            else:
                spec["artifacts"][axis]["locator"] = {"declaration": "different-exact-declaration"}
            with self.subTest(axis=axis):
                self.assertNotEqual(baseline["reuse_key"], self.read(self.build(spec), "reuse.json")["reuse_key"])
        spec = copy.deepcopy(self.spec)
        spec["dynamic"]["round"] = 10
        spec["resource_boundary"]["seconds"] = 120
        changed = self.read(self.build(spec), "reuse.json")
        self.assertEqual(baseline["reuse_key"], changed["reuse_key"])
        self.assertNotEqual(baseline["failure_key"], changed["failure_key"])
        (self.root / "policy.txt").write_text("changed policy implementation\n")
        self.assertNotEqual(baseline["reuse_key"], self.read(self.build(), "reuse.json")["reuse_key"])

    def test_unknown_versions_never_generate_reuse_or_failure_key(self):
        self.spec["environment"]["libraries"]["core"] = None
        result = self.read(self.build(), "reuse.json")
        self.assertIsNone(result["reuse_key"])
        self.assertIsNone(result["failure_key"])
        self.assertEqual(result["machine_verification"], "not_assessed")

    def test_reject_missing_cycle_escape_and_oversize(self):
        missing = copy.deepcopy(self.spec)
        missing["artifacts"]["proof"]["dependencies"].append("missing")
        with self.assertRaisesRegex(ValueError, "missing dependency"):
            self.build(missing)
        cycle = copy.deepcopy(self.spec)
        cycle["artifacts"]["definitions"]["dependencies"].append("proof")
        with self.assertRaisesRegex(ValueError, "cyclic"):
            self.build(cycle)
        with tempfile.TemporaryDirectory() as outside:
            secret = Path(outside) / "outside.txt"
            secret.write_text("not evidence")
            (self.root / "escape.txt").symlink_to(secret)
            escaped = copy.deepcopy(self.spec)
            escaped["artifacts"]["proof"]["path"] = "escape.txt"
            with self.assertRaisesRegex(ValueError, "escapes"):
                self.build(escaped)
        with self.assertRaisesRegex(ValueError, "byte limit"):
            self.build(limit=10)

    def test_tamper_and_overwrite_rejected(self):
        first = self.build()
        spec = self.root / "spec-1.json"
        with self.assertRaisesRegex(ValueError, "already exists"):
            pack.build(self.root, spec, first)
        manifest = pack.verify(first)
        blob = first / manifest["artifacts"]["lemma"]["blob"]
        blob.write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            self.build(previous=first)

    def test_binary_archive_but_required_binary_blocks(self):
        (self.root / "history.txt").write_bytes(b"\xff\x00binary")
        pack.verify(self.build())
        self.spec["review_roots"] = ["history"]
        with self.assertRaisesRegex(ValueError, "readable text"):
            self.build()

    def test_unknown_objection_stays_open_and_closed_not_silently_filtered(self):
        self.spec["open_objections"][0]["status"] = "unknown"
        output = self.build()
        self.assertIn("UNRESOLVED OBJECTION", self.read(output, "messages.json")[1]["content"])
        self.spec["open_objections"][0]["status"] = "repaired"
        with self.assertRaisesRegex(ValueError, "closed entries"):
            self.build()


class UsageTests(unittest.TestCase):
    def row(self, rid="receipt-1", **changes):
        return {"provider": "synthetic", "model": "synthetic", "response_id": rid,
                "request_sha256": "a" * 64, "input_tokens": 100, "cached_input_tokens": 60,
                "usage_source": {"path": "synthetic.json", "sha256": "b" * 64}, **changes}

    def test_observed_ratio_deduplication_and_unknown_coverage(self):
        rows = [self.row(), self.row(), self.row("receipt-2", cached_input_tokens=None)]
        result = pack.usage_summary(rows)["groups"][0]
        self.assertEqual(result["requests"], 2)
        self.assertEqual(result["duplicate_rows"], 1)
        self.assertEqual(result["coverage"], 0.5)
        self.assertEqual(result["observed_cache_hit_ratio"], 0.6)

    def test_conflicting_missing_invalid_or_zero_never_fabricate_hits(self):
        rows = [self.row(), self.row(cached_input_tokens=80),
                self.row("receipt-2", cached_input_tokens=101), self.row(None),
                self.row("receipt-3", input_tokens=0, cached_input_tokens=0)]
        result = pack.usage_summary(rows)["groups"][0]
        self.assertEqual(result["conflicting_receipts"], 1)
        self.assertEqual(result["observed_requests"], 1)
        self.assertIsNone(result["observed_cache_hit_ratio"])
        result = pack.usage_summary([self.row(cached_input_tokens=None)])["groups"][0]
        self.assertIsNone(result["observed_cached_input_tokens"])
        self.assertEqual(result["coverage"], 0)


if __name__ == "__main__":
    unittest.main()
