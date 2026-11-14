"""MongoDB case store. The parity test always runs; the rest need ROADWATCH_TEST_MONGODB_URI (a disposable server)."""
import inspect
import os
import re
import threading
import time

import pytest

pytest.importorskip("pymongo")

from roadwatch import migrate_mongo, store, store_mongo  # noqa: E402

needs_mongo = pytest.mark.skipif(not os.environ.get("ROADWATCH_TEST_MONGODB_URI"), reason="set ROADWATCH_TEST_MONGODB_URI")


def test_every_store_function_has_a_mongo_twin_with_the_same_signature():
    routed = re.findall(r"@_backend\ndef (\w+)\(", inspect.getsource(store))
    assert len(routed) >= 24
    for name in routed:
        assert inspect.signature(getattr(store, name).__wrapped__) == inspect.signature(getattr(store_mongo, name)), name


def test_sqlite_is_used_when_no_uri_is_set(tmp_path, monkeypatch):
    monkeypatch.delenv("ROADWATCH_MONGODB_URI", raising=False)
    monkeypatch.setenv("ROADWATCH_DB", str(tmp_path / "plain.sqlite3"))
    project = store.create_project({"name": "Local", "road": "Rue A", "contractor": ""})
    assert (tmp_path / "plain.sqlite3").exists() and store.get_project(project["id"])["name"] == "Local"


@needs_mongo
def test_case_round_trip_keeps_awkward_field_names_and_splits_large_lists():
    db = store_mongo._db()
    project = store.create_project({"name": "Case", "road": "Rue A", "contractor": "ABC inc."})
    record = {"Amount $": 1563741.85, "No. of bids": 3, "$ref": "x", "": "blank header", "Montréal": ["é", None, True]}
    store.append_item(project["id"], "evidence", {"id": "evidence-1", "title": "Award", "pages": [{"number": 1, "text": "Award date: 2024-08-16"}]})
    store.append_item(project["id"], "open_data", {"key": "awarded", "records": [record], "total": 1})
    store.append_item(project["id"], "finances", {"amount": 10})
    saved = store.get_project(project["id"])
    assert saved["open_data"][0]["records"][0] == record and list(saved["open_data"][0]["records"][0]) == list(record)
    store_mongo._parts.clear()
    assert store.get_project(project["id"]) == saved and list(store.get_project(project["id"])["open_data"][0]["records"][0]) == list(record)
    assert saved["evidence"][0]["pages"][0]["text"] == "Award date: 2024-08-16"
    assert saved["revision"] == 3 and saved["finances"] == [{"amount": 10}]
    core = db.projects.find_one({"_id": project["id"]})
    assert "evidence" not in core["body"] and "open_data" not in core["body"]
    assert db.parts.count_documents({"project_id": project["id"]}) == 2
    assert store.project_summaries() == [{"id": project["id"], "name": "Case", "road": "Rue A", "contractor": "ABC inc.",
                                          "demo": False, "created_at": project["created_at"], "anchor": "street"}]
    assert store.list_projects()[0]["evidence"][0]["id"] == "evidence-1"


@needs_mongo
def test_an_edit_rewrites_only_the_items_it_changed():
    db = store_mongo._db()
    project = store.create_project({"name": "Case", "road": "Rue A", "contractor": ""})
    for n in range(3):
        store.append_item(project["id"], "evidence", {"id": f"evidence-{n}", "title": f"Doc {n}", "pages": []})
    before = db.projects.find_one({"_id": project["id"]})["parts"]["evidence"]

    def retitle(current):
        current["evidence"][1]["title"] = "Renamed"
    store.mutate(project["id"], retitle)
    after = db.projects.find_one({"_id": project["id"]})["parts"]["evidence"]
    assert after[0] == before[0] and after[2] == before[2] and after[1] != before[1]

    store.mutate(project["id"], lambda current: current["evidence"].pop(0))
    assert [e["title"] for e in store.get_project(project["id"])["evidence"]] == ["Renamed", "Doc 2"]
    assert db.parts.count_documents({"project_id": project["id"]}) == 2

    assert store.delete_project(project["id"]) and not store.delete_project(project["id"])
    assert db.parts.count_documents({"project_id": project["id"]}) == 0 and store.get_project(project["id"]) is None
    with pytest.raises(KeyError):
        store.mutate(project["id"], lambda current: None)


@needs_mongo
def test_concurrent_edits_do_not_overwrite_each_other():
    db = store_mongo._db()
    project = store.create_project({"name": "Busy", "road": "Rue A", "contractor": ""})
    errors = []

    def work(worker):
        try:
            for n in range(10):
                store.append_item(project["id"], "evidence", {"id": f"evidence-{worker}-{n}", "pages": []})
                store.append_item(project["id"], "finances", {"entry": f"{worker}-{n}"})
        except Exception as error:
            errors.append(error)
    threads = [threading.Thread(target=work, args=(w,)) for w in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    saved = store.get_project(project["id"])
    assert not errors
    assert len({e["id"] for e in saved["evidence"]}) == 60 and len(saved["finances"]) == 60 and saved["revision"] == 120
    assert db.parts.count_documents({"project_id": project["id"]}) == 60


@needs_mongo
def test_daily_ai_cap_members_discussion_and_statuses():
    assert [store.reserve_ai_run(2) for _ in range(3)] == [True, True, False]
    assert store.ai_runs_today() == 2 and not store.reserve_ai_run(0)

    member = store.add_member("Ana", "investigator", "hash-1", email="ana@example.org", invite_hash="invite-1", invite_expires=99)
    assert member["has_password"] == 0 and member["invited"] == 1 and "key_hash" not in member
    assert store.member_by_email("ANA@example.org")["key_hash"] == "hash-1"
    assert store.member_by_invite_hash("invite-1")["id"] == member["id"]
    updated = store.update_member(member["id"], password_hash="pw", invite_hash=None, active=False, ignored="x")
    assert updated["has_password"] == 1 and updated["invited"] == 0 and updated["active"] == 0
    assert store.member_by_key_hash("hash-1") is None and store.members() == []
    assert [m["name"] for m in store.members(include_inactive=True)] == ["Ana"]
    with pytest.raises(Exception):
        store.add_member("Twin", "viewer", "hash-2", email="ana@example.org")

    comment = store.add_comment("project-1", {"text": "Check page 2", "author": "Ana"})
    store.save_comment({**comment, "text": "Check page 3"})
    assert [c["text"] for c in store.comments("project-1")] == ["Check page 3"]
    assert store.delete_comment(comment["id"]) and store.get_comment(comment["id"]) is None and store.comments("project-1") == []
    store.set_finding_status("project-1", "key|with.dots", {"status": "explained"})
    store.set_finding_status("project-1", "key|with.dots", {"status": "escalated"})
    assert {k: v["status"] for k, v in store.finding_statuses("project-1").items()} == {"key|with.dots": "escalated"}


@needs_mongo
def test_migration_copies_a_sqlite_database(tmp_path, monkeypatch):
    uri = os.environ["ROADWATCH_MONGODB_URI"]
    monkeypatch.delenv("ROADWATCH_MONGODB_URI")
    monkeypatch.setenv("ROADWATCH_DB", str(tmp_path / "old.sqlite3"))
    project = store.create_project({"name": "Old case", "road": "Rue A", "contractor": ""})
    store.append_item(project["id"], "evidence", {"id": "evidence-1", "pages": [{"number": 1, "text": "x"}]})
    member = store.add_member("Ana", "admin", "hash-1", email="ana@example.org", password_hash="pw")
    comment = store.add_comment(project["id"], {"text": "note"})
    store.set_finding_status(project["id"], "k", {"status": "dismissed"})
    store.reserve_ai_run(5)
    store.support_acquire(member["id"], project["id"], "turn", time.time() + 3600, time.time() + 60)
    store.support_complete(member["id"], project["id"], "turn", {"message": "Where do I start?", "answer": "Open the map."})
    store.reserve_support_run(member["id"], 1)
    expected = store.get_project(project["id"])

    monkeypatch.setenv("ROADWATCH_MONGODB_URI", uri)
    assert migrate_mongo.migrate()["cases"] == 1
    assert store.get_project(project["id"]) == expected
    assert store.member_by_email("ana@example.org")["id"] == member["id"] and store.public_member(member["id"])["has_password"] == 1
    assert store.comments(project["id"])[0]["id"] == comment["id"]
    assert store.finding_statuses(project["id"])["k"]["status"] == "dismissed" and store.ai_runs_today() == 1
    assert store.support_history(member["id"], project["id"])[0]["answer"] == "Open the map."
    assert not store.reserve_support_run(member["id"], 1)
    with pytest.raises(SystemExit):
        migrate_mongo.migrate()
    assert migrate_mongo.migrate(replace=True)["cases"] == 1 and len(store.list_projects()) == 1
