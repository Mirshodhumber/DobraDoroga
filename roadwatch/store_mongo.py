"""MongoDB backend for the case store: the same functions as store.py, used when ROADWATCH_MONGODB_URI is set.

A case is one small document in `projects` plus one document per evidence file, open-data set and report in
`parts`. That keeps a case clear of MongoDB's 16 MB document limit, lets the case list load without any
evidence, and makes an edit write only the items it changed. The case document lists its parts by id and
carries a write counter; an edit commits by updating that document only if the counter is unchanged and is
retried otherwise, which is this backend's equivalent of store.py's BEGIN IMMEDIATE.
"""

import json
import os
import threading
import uuid
from collections import OrderedDict
from datetime import datetime, timedelta, timezone

import certifi
from pymongo import ASCENDING, MongoClient
from pymongo.collation import Collation
from pymongo.errors import DuplicateKeyError

from . import search
from .store import _support_summary, _upgrade, identifier, now, support_key

SPLIT = ("evidence", "open_data", "reports")
SUMMARY_FIELDS = ("id", "name", "road", "contractor", "demo", "created_at", "anchor")
MEMBER_FIELDS = ("name", "role", "active", "key_hash", "email", "password_hash", "invite_hash", "invite_expires",
                 "token_salt", "last_login", "verified")
PUBLIC_MEMBER = ("name", "role", "email", "created_at", "active", "last_login", "verified")
SECRET_MEMBER = ("password_hash", "invite_hash", "invite_expires", "token_salt", "key_hash")

CACHE_CHARACTERS = 300_000_000

_clients, _ready = {}, set()
_parts, _parts_lock, _parts_size = OrderedDict(), threading.Lock(), 0


def _db():
    uri = os.environ["ROADWATCH_MONGODB_URI"]
    if uri not in _clients:
        encrypted = uri.startswith("mongodb+srv://") or "tls=true" in uri.lower() or "ssl=true" in uri.lower()
        _clients[uri] = MongoClient(uri, serverSelectionTimeoutMS=8000, appname="roadwatch", compressors="zlib",
                                    **({"tlsCAFile": certifi.where()} if encrypted else {}))
    name = os.environ.get("ROADWATCH_MONGODB_DB") or _clients[uri].get_default_database(default="roadwatch").name
    db = _clients[uri][name]
    if (uri, name) not in _ready:
        db.parts.create_index([("project_id", ASCENDING)])
        db.parts.create_index([("body.title", "text"), ("body.pages.text", "text")], name="evidence_text",
                              default_language="none", language_override="_text_language")
        db.members.create_index([("key_hash", ASCENDING)], unique=True)
        db.members.create_index([("email", ASCENDING)], unique=True, partialFilterExpression={"email": {"$type": "string"}})
        db.comments.create_index([("project_id", ASCENDING), ("created_at", ASCENDING)])
        db.finding_status.create_index([("project_id", ASCENDING), ("finding_key", ASCENDING)], unique=True)
        db.support_threads.create_index("expires_at", expireAfterSeconds=0)
        db.support_threads.create_index("project_id")
        db.support_usage.create_index("expires_at", expireAfterSeconds=0)
        _ready.add((uri, name))
    return db


def _plain(value):
    """What a JSON round trip leaves, so both backends store and return the same shapes."""
    return json.loads(json.dumps(value))


def _fingerprint(kind, item):
    return kind, json.dumps(item, sort_keys=True)


def _split(project_id, project, known=None):
    """(case document body, part ids by kind, part documents not stored yet)."""
    known = known or {}
    manifest, new = {}, []
    for kind in SPLIT:
        manifest[kind] = []
        for item in project.get(kind, []):
            fingerprint = _fingerprint(kind, item)
            part_id = known.get(fingerprint)
            if not part_id:
                part_id = known[fingerprint] = f"part-{uuid.uuid4().hex}"
                new.append({"_id": part_id, "project_id": project_id, "kind": kind, "body": json.loads(json.dumps(item))})
            manifest[kind].append(part_id)
    return _plain({k: v for k, v in project.items() if k not in SPLIT}), manifest, new


def _remember(part_id, text):
    global _parts_size
    with _parts_lock:
        if part_id not in _parts:
            _parts[part_id] = text
            _parts_size += len(text)
            while _parts_size > CACHE_CHARACTERS and len(_parts) > 1:
                _parts_size -= len(_parts.popitem(last=False)[1])


def _bodies(db, wanted):
    """Part bodies by id. A part is never modified after it is written (an edit stores a new one), so bodies are
    kept in memory as JSON text and only the ones not seen yet are downloaded."""
    texts = {}
    with _parts_lock:
        for part_id in wanted:
            if part_id in _parts:
                _parts.move_to_end(part_id)
                texts[part_id] = _parts[part_id]
    missing = [part_id for part_id in wanted if part_id not in texts]
    if missing:
        for part in db.parts.find({"_id": {"$in": missing}}):
            texts[part["_id"]] = json.dumps(part["body"])
            _remember(part["_id"], texts[part["_id"]])
    return {part_id: json.loads(part_text) for part_id, part_text in texts.items()}


def _store(db, new):
    if new:
        db.parts.insert_many(new)
        for part in new:
            _remember(part["_id"], json.dumps(part["body"]))


def _part_ids(document):
    return [part_id for kind in SPLIT for part_id in document["parts"][kind]]


def _read(db, project_id):
    """(case document, assembled case); re-read when an edit replaced parts between the two queries."""
    for _ in range(20):
        document = db.projects.find_one({"_id": project_id})
        if not document:
            return None, None
        wanted = _part_ids(document)
        found = _bodies(db, wanted)
        if all(part_id in found for part_id in wanted):
            return document, {**document["body"], **{kind: [found[i] for i in document["parts"][kind]] for kind in SPLIT}}
    raise RuntimeError(f"Case {project_id} kept changing while it was being read.")


def delete_project(project_id):
    db = _db()
    deleted = db.projects.delete_one({"_id": project_id}).deleted_count > 0
    db.parts.delete_many({"project_id": project_id})
    db.chunks.delete_many({"project_id": project_id})
    db.support_threads.delete_many({"project_id": project_id})
    return deleted


def reserve_ai_run(daily_limit):
    """Atomically count an AI run against today's cap. Returns False when the cap is reached."""
    if daily_limit <= 0:
        return False
    day = datetime.now(timezone.utc).date().isoformat()
    try:
        _db().ai_usage.update_one({"_id": day, "runs": {"$lt": daily_limit}}, {"$inc": {"runs": 1}}, upsert=True)
    except DuplicateKeyError:
        return False
    return True


def ai_runs_today():
    row = _db().ai_usage.find_one({"_id": datetime.now(timezone.utc).date().isoformat()})
    return row["runs"] if row else 0


def list_projects():
    db = _db()
    for _ in range(20):
        documents = list(db.projects.find().sort("created_at", -1))
        parts = _bodies(db, [part_id for d in documents for part_id in _part_ids(d)])
        if all(part_id in parts for d in documents for part_id in _part_ids(d)):
            return [{**d["body"], **{kind: [parts[i] for i in d["parts"][kind]] for kind in SPLIT}} for d in documents]
    raise RuntimeError("Cases kept changing while they were being listed.")


def project_summaries():
    """The fields the case list shows, read without loading evidence, open data or reports."""
    rows = _db().projects.find({}, {f"body.{field}": 1 for field in SUMMARY_FIELDS}).sort("created_at", -1)
    return [{field: row["body"].get(field) for field in SUMMARY_FIELDS} for row in rows]


def search_evidence(query, limit=40):
    """Pages of evidence, in any case, that contain every word of `query`. The text index finds the documents;
    search.evidence_hits picks the pages, so results match the SQLite store's."""
    wanted = search.words(query)
    if not wanted:
        return []
    db = _db()
    names, live = {}, set()
    for row in db.projects.find({}, {"body.name": 1, "parts.evidence": 1}):
        names[row["_id"]] = row["body"].get("name")
        live.update(row["parts"]["evidence"])
    found = db.parts.find({"kind": "evidence", "$text": {"$search": " ".join(f'"{word}"' for word in wanted)}},
                          {"project_id": 1, "score": {"$meta": "textScore"}}).sort([("score", {"$meta": "textScore"})]).limit(200)
    candidates = [(row["_id"], row["project_id"]) for row in found if row["_id"] in live]
    bodies = _bodies(db, [part_id for part_id, _ in candidates])
    hits = []
    for part_id, project_id in candidates:
        if part_id in bodies:
            hits += search.evidence_hits(project_id, names[project_id], bodies[part_id], wanted, limit - len(hits))
        if len(hits) >= limit:
            break
    return hits


def get_project(project_id):
    project = _read(_db(), project_id)[1]
    return _upgrade(project) if project else None


def create_project(fields, *, demo=False):
    project = {
        "locations": [], "anchor": "street", "vendor": None, **fields, "id": identifier("project"), "created_at": now(),
        "demo": demo, "revision": 0, "evidence": [], "finances": [], "observations": [], "reports": [],
        "open_data": [],
    }
    db = _db()
    body, manifest, new = _split(project["id"], project)
    _store(db, new)
    db.projects.insert_one({"_id": project["id"], "created_at": project["created_at"], "writes": 0, "body": body, "parts": manifest})
    return project


def mutate(project_id, callback):
    """Serialize edits so concurrent requests cannot overwrite evidence."""
    db = _db()
    for _ in range(200):
        document, project = _read(db, project_id)
        if not document:
            raise KeyError(project_id)
        project = _upgrade(project)
        known = {_fingerprint(kind, item): part_id
                 for kind in SPLIT for part_id, item in zip(document["parts"][kind], project[kind])}
        callback(project)
        body, manifest, new = _split(project_id, project, known)
        _store(db, new)
        committed = db.projects.update_one({"_id": project_id, "writes": document["writes"]},
                                           {"$set": {"body": body, "parts": manifest}, "$inc": {"writes": 1}}).matched_count
        dropped = set(_part_ids(document)) - {i for ids in manifest.values() for i in ids} if committed else {p["_id"] for p in new}
        if dropped:
            db.parts.delete_many({"_id": {"$in": list(dropped)}})
            db.chunks.delete_many({"part_id": {"$in": list(dropped)}})
        if committed:
            return project
    raise RuntimeError(f"Case {project_id} is being edited too heavily to save. Try again.")


def append_item(project_id, collection, item):
    def update(project):
        project[collection].append(item)
        project["revision"] += 1
    return mutate(project_id, update)


# ---- team members ---------------------------------------------------------------------------------

def _public(row):
    if not row:
        return None
    return {"id": row["_id"], **{field: row.get(field) for field in PUBLIC_MEMBER},
            "has_password": int(row.get("password_hash") is not None), "invited": int(row.get("invite_hash") is not None)}


def _secret(row):
    return {**_public(row), **{field: row.get(field) for field in SECRET_MEMBER}} if row else None


def members(include_inactive=False):
    rows = _db().members.find().sort("created_at", ASCENDING)
    return [_public(r) for r in rows if include_inactive or r["active"]]


def add_member(name, role, key_hash, email=None, invite_hash=None, invite_expires=None, password_hash=None, verified=1):
    member_id = identifier("member")
    _db().members.insert_one({"_id": member_id, "name": name, "role": role, "key_hash": key_hash, "created_at": now(), "active": 1,
                              "email": email, "invite_hash": invite_hash, "invite_expires": invite_expires, "token_salt": "",
                              "password_hash": password_hash, "last_login": None, "verified": int(verified)})
    return public_member(member_id)


def member_by_key_hash(key_hash):
    return _secret(_db().members.find_one({"key_hash": key_hash, "active": 1}))


def member_by_email(email):
    return _secret(_db().members.find_one({"email": email}, collation=Collation(locale="en", strength=2)))


def member_by_invite_hash(invite_hash):
    return _secret(_db().members.find_one({"invite_hash": invite_hash, "active": 1}))


def member(member_id):
    """Full row including secrets - for auth only."""
    return _secret(_db().members.find_one({"_id": member_id}))


def public_member(member_id):
    return _public(_db().members.find_one({"_id": member_id}))


def update_member(member_id, **fields):
    allowed = {k: int(v) if isinstance(v, bool) else v for k, v in fields.items() if k in MEMBER_FIELDS}
    if allowed:
        _db().members.update_one({"_id": member_id}, {"$set": allowed})
    return public_member(member_id)


# ---- discussion -------------------------------------------------------------------------------------

def comments(project_id):
    """All non-deleted comments of a case; the body holds author, anchor, citations and assessment fields."""
    rows = _db().comments.find({"project_id": project_id, "deleted": False}).sort("created_at", ASCENDING)
    return [r["body"] for r in rows]


def add_comment(project_id, comment):
    comment = {**comment, "id": identifier("comment"), "project_id": project_id, "created_at": now(), "edited_at": None}
    _db().comments.insert_one({"_id": comment["id"], "project_id": project_id, "created_at": comment["created_at"],
                               "deleted": False, "body": _plain(comment)})
    return comment


def get_comment(comment_id):
    row = _db().comments.find_one({"_id": comment_id, "deleted": False})
    return row["body"] if row else None


def save_comment(comment):
    _db().comments.update_one({"_id": comment["id"]}, {"$set": {"body": _plain(comment)}})
    return comment


def delete_comment(comment_id):
    return _db().comments.update_one({"_id": comment_id}, {"$set": {"deleted": True}}).matched_count > 0


def finding_statuses(project_id):
    return {r["finding_key"]: r["body"] for r in _db().finding_status.find({"project_id": project_id})}


def set_finding_status(project_id, finding_key, status):
    status = {**status, "project_id": project_id, "finding_key": finding_key, "updated_at": now()}
    _db().finding_status.replace_one({"project_id": project_id, "finding_key": finding_key},
                                     {"project_id": project_id, "finding_key": finding_key, "body": _plain(status)}, upsert=True)
    return status


def support_case_summary(project_id):
    """Read counts and one report revision without downloading evidence or report snapshots."""
    db = _db()
    row = db.projects.find_one({"_id": project_id})
    if not row:
        return None
    counts = {k: len(row["parts"].get(k, [])) for k in SPLIT}
    counts.update({k: len(row["body"].get(k, [])) for k in ("finances", "observations")})
    report_ids = row["parts"].get("reports", [])
    last = db.parts.find_one({"_id": report_ids[-1]}, {"body.revision": 1}) if report_ids else None
    return _support_summary(row["body"], counts, last.get("body") if last else None)


def support_history(owner_id, project_id):
    row = _db().support_threads.find_one({"_id": support_key(owner_id, project_id), "owner_id": owner_id,
                                         "expires_at": {"$gt": datetime.now(timezone.utc)}})
    return row["messages"] if row else []


def support_acquire(owner_id, project_id, run_id, expires_at, lease_until):
    db, stamp, key = _db(), datetime.now(timezone.utc), support_key(owner_id, project_id)
    db.support_threads.delete_one({"_id": key, "expires_at": {"$lte": stamp}})
    try:
        db.support_threads.update_one(
            {"_id": key, "owner_id": owner_id, "lock_until": {"$lte": stamp}},
            {"$set": {"run_id": run_id, "lock_until": datetime.fromtimestamp(lease_until, timezone.utc),
                      "expires_at": datetime.fromtimestamp(expires_at, timezone.utc)},
             "$setOnInsert": {"project_id": project_id, "messages": []}}, upsert=True)
    except DuplicateKeyError:  # Another worker owns this conversation's lease.
        return False
    return True


def support_complete(owner_id, project_id, run_id, turn):
    stamp = datetime.now(timezone.utc)
    return _db().support_threads.update_one(
        {"_id": support_key(owner_id, project_id), "owner_id": owner_id, "run_id": run_id,
         "lock_until": {"$gt": stamp}, "expires_at": {"$gt": stamp}},
        {"$push": {"messages": {"$each": [_plain(turn)], "$slice": -12}},
         "$set": {"lock_until": datetime.fromtimestamp(0, timezone.utc), "run_id": None}}).matched_count > 0


def support_release(owner_id, project_id, run_id):
    _db().support_threads.update_one({"_id": support_key(owner_id, project_id), "owner_id": owner_id, "run_id": run_id},
                                    {"$set": {"lock_until": datetime.fromtimestamp(0, timezone.utc), "run_id": None}})


def support_clear(owner_id, project_id):
    _db().support_threads.delete_one({"_id": support_key(owner_id, project_id), "owner_id": owner_id})


def reserve_support_run(owner_id, daily_limit):
    if daily_limit <= 0:
        return False
    stamp = datetime.now(timezone.utc)
    key = support_key(owner_id, stamp.date().isoformat())
    try:
        _db().support_usage.update_one({"_id": key, "runs": {"$lt": daily_limit}},
                                      {"$inc": {"runs": 1}, "$setOnInsert": {"expires_at": stamp + timedelta(days=30)}}, upsert=True)
    except DuplicateKeyError:
        return False
    return True
