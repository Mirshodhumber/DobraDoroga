"""Copy the SQLite case database into MongoDB.

    python -m roadwatch.migrate_mongo            # refuses if the MongoDB database already holds cases
    python -m roadwatch.migrate_mongo --replace  # empties the MongoDB collections first

Reads ROADWATCH_DB (or data/roadwatch.sqlite3) and writes to ROADWATCH_MONGODB_URI, both taken from the
environment or .env. The SQLite file is only read, so it stays as a backup.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

from . import store

COLLECTIONS = ("projects", "parts", "members", "comments", "finding_status", "ai_usage", "support_threads", "support_usage")


def migrate(replace=False):
    from . import store_mongo
    db = store_mongo._db()
    if db.projects.estimated_document_count() or db.members.estimated_document_count():
        if not replace:
            raise SystemExit(f"MongoDB database '{db.name}' already holds cases or accounts. Pass --replace to overwrite it.")
        for name in COLLECTIONS:
            db[name].delete_many({})
    with store.database() as connection:
        projects = [json.loads(row["body"]) for row in connection.execute("SELECT body FROM projects")]
        members = [dict(row) for row in connection.execute("SELECT * FROM members")]
        comments = [dict(row) for row in connection.execute("SELECT * FROM comments")]
        statuses = [dict(row) for row in connection.execute("SELECT * FROM finding_status")]
        usage = [dict(row) for row in connection.execute("SELECT * FROM ai_usage")]
        support_threads = [dict(row) for row in connection.execute("SELECT * FROM support_threads")]
        support_usage = [dict(row) for row in connection.execute("SELECT * FROM support_usage")]
    for project in projects:
        body, manifest, parts = store_mongo._split(project["id"], project)
        store_mongo._store(db, parts)
        db.projects.insert_one({"_id": project["id"], "created_at": project["created_at"], "writes": 0, "body": body, "parts": manifest})
    if members:
        db.members.insert_many([{"_id": m.pop("id"), **m} for m in members])
    if comments:
        db.comments.insert_many([{"_id": c["id"], "project_id": c["project_id"], "created_at": c["created_at"],
                                  "deleted": bool(c["deleted"]), "body": json.loads(c["body"])} for c in comments])
    if statuses:
        db.finding_status.insert_many([{"project_id": s["project_id"], "finding_key": s["finding_key"], "body": json.loads(s["body"])}
                                       for s in statuses])
    if usage:
        db.ai_usage.insert_many([{"_id": u["day"], "runs": u["runs"]} for u in usage])
    if support_threads:
        db.support_threads.insert_many([{
            "_id": t["id"], "owner_id": t["owner_id"], "project_id": t["project_id"], "messages": json.loads(t["messages"]),
            "expires_at": datetime.fromtimestamp(t["expires_at"], timezone.utc),
            # No worker is processing a SQLite chat in the new deployment.
            "lock_until": datetime.fromtimestamp(0, timezone.utc), "run_id": None,
        } for t in support_threads])
    if support_usage:
        from datetime import timedelta
        db.support_usage.insert_many([{
            "_id": store.support_key(u["owner_id"], u["day"]), "runs": u["runs"],
            "expires_at": datetime.fromisoformat(u["day"]).replace(tzinfo=timezone.utc) + timedelta(days=30),
        } for u in support_usage])
    return {"database": db.name, "cases": len(projects), "parts": db.parts.estimated_document_count(), "members": len(members),
            "comments": len(comments), "finding_statuses": len(statuses)}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--replace", action="store_true", help="empty the MongoDB collections before copying")
    args = parser.parse_args()
    load_dotenv(Path(__file__).parent.parent / ".env")
    if not os.environ.get("ROADWATCH_MONGODB_URI"):
        sys.exit("Set ROADWATCH_MONGODB_URI (in .env or the environment) first.")
    print(json.dumps(migrate(args.replace), indent=1))


if __name__ == "__main__":
    main()
