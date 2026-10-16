from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from typing import Any

SHANGHAI = timezone(timedelta(hours=8), "Asia/Shanghai")
DAV = "DAV:"
CALDAV = "urn:ietf:params:xml:ns:caldav"


def ical_escape(value: Any) -> str:
    clean = str(value or "").encode("utf-8", errors="replace").decode("utf-8")
    return clean.replace("\\", "\\\\").replace("\r\n", "\\n").replace("\n", "\\n").replace(";", "\\;").replace(",", "\\,")


def fold_line(line: str, limit: int = 73) -> list[str]:
    parts: list[str] = []
    current = ""
    current_bytes = 0
    for char in line:
        encoded = char.encode("utf-8")
        if current and current_bytes + len(encoded) > limit:
            parts.append(current)
            current = " " + char
            current_bytes = 1 + len(encoded)
        else:
            current += char
            current_bytes += len(encoded)
    parts.append(current)
    return parts


def render_event(item: dict[str, Any], uid: str) -> bytes:
    start = datetime.fromisoformat(f"{item['plan_date']}T{item['start_time']}:00+08:00")
    end = datetime.fromisoformat(f"{item['plan_date']}T{item['end_time']}:00+08:00") if item.get("end_time") else start + timedelta(hours=2)
    if end <= start:
        end += timedelta(days=1)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MashiroBot//Plan QQ Calendar//CN", "CALSCALE:GREGORIAN",
        "BEGIN:VEVENT", f"UID:{ical_escape(uid)}", f"DTSTAMP:{stamp}",
        f"DTSTART;TZID=Asia/Shanghai:{start.strftime('%Y%m%dT%H%M%S')}",
        f"DTEND;TZID=Asia/Shanghai:{end.strftime('%Y%m%dT%H%M%S')}",
        f"SUMMARY:{ical_escape(item['title'])}",
        f"DESCRIPTION:{ical_escape('MashiroBot Plan\\nplan_item_id=' + item['plan_item_id'])}",
        "END:VEVENT", "END:VCALENDAR",
    ]
    return ("\r\n".join(part for line in lines for part in fold_line(line)) + "\r\n").encode("utf-8")


class CalDAVError(RuntimeError):
    def __init__(self, message: str, *, status: int | None = None, retryable: bool = False, paused: bool = False):
        super().__init__(message)
        self.status = status
        self.retryable = retryable
        self.paused = paused


class QQCalDAVClient:
    def __init__(self, endpoint: str, username: str, password: str, timeout: float = 20):
        self.endpoint = endpoint.rstrip("/") + "/"
        self.username = username
        self.timeout = timeout
        token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
        self.authorization = f"Basic {token}"

    def request(self, method: str, url: str, body: bytes | None = None, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], bytes]:
        target = urllib.parse.urljoin(self.endpoint, url)
        values = {"Authorization": self.authorization, "User-Agent": "MashiroBot-Plan-CalDAV/1.0"}
        values.update(headers or {})
        req = urllib.request.Request(target, data=body, method=method, headers=values)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                return response.status, {k.casefold(): v for k, v in response.headers.items()}, response.read()
        except urllib.error.HTTPError as error:
            status = int(error.code)
            if status in (401, 403):
                raise CalDAVError(f"CalDAV authorization failed (HTTP {status})", status=status, paused=True) from None
            if status == 429 or status >= 500:
                raise CalDAVError(f"CalDAV temporarily unavailable (HTTP {status})", status=status, retryable=True) from None
            raise CalDAVError(f"CalDAV request failed (HTTP {status})", status=status) from None
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise CalDAVError(f"CalDAV network error: {type(error).__name__}", retryable=True) from None

    def discover_calendar(self, name: str, known_url: str | None = None) -> str:
        if known_url:
            return known_url
        body = b'''<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>'''
        collection_roots: list[str] = []
        for path in ("calendar/", "caldav/", ""):
            try:
                _, _, raw = self.request("PROPFIND", path, body, {"Depth": "1", "Content-Type": "application/xml; charset=utf-8"})
            except CalDAVError as error:
                if error.status == 404:
                    continue
                raise
            try:
                root = ET.fromstring(raw)
            except ET.ParseError:
                continue
            collection_roots.append(path)
            for response in root.findall(f".//{{{DAV}}}response"):
                display = response.find(f".//{{{DAV}}}displayname")
                calendar = response.find(f".//{{{CALDAV}}}calendar")
                href = response.find(f"{{{DAV}}}href")
                if calendar is not None and href is not None and (display.text or "").strip() == name:
                    return urllib.parse.urljoin(self.endpoint, href.text or "")
        calendar_slug = "mashirobot-plan-" + hashlib.sha256(self.username.encode("utf-8")).hexdigest()[:12]
        create_body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            '<d:set><d:prop><d:displayname>' + ical_escape(name) + '</d:displayname>'
            '<c:supported-calendar-component-set><c:comp name="VEVENT"/>'
            '</c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>'
        ).encode("utf-8")
        last_error: CalDAVError | None = None
        for root_path in collection_roots or ["calendar/"]:
            candidate = urllib.parse.urljoin(self.endpoint, root_path.rstrip("/") + "/" + calendar_slug + "/")
            try:
                self.request("MKCALENDAR", candidate, create_body, {"Content-Type": "application/xml; charset=utf-8"})
                return candidate
            except CalDAVError as error:
                last_error = error
                if error.status not in (404, 405, 409):
                    raise
        if last_error:
            raise CalDAVError(f"Calendar not found and could not be created: {name} ({last_error})", status=last_error.status)
        raise CalDAVError(f"Calendar not found: {name}")

    @staticmethod
    def resource_url(calendar_url: str, uid: str) -> str:
        filename = hashlib.sha256(uid.encode("utf-8")).hexdigest() + ".ics"
        return calendar_url.rstrip("/") + "/" + filename

    def read_resource(self, calendar_url: str, resource_url: str) -> tuple[str | None, bytes]:
        href = urllib.parse.urlparse(resource_url).path
        body = (
            '<?xml version="1.0" encoding="utf-8"?>'
            '<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
            '<d:prop><d:getetag/><c:calendar-data/></d:prop><d:href>'
            + href + '</d:href></c:calendar-multiget>'
        ).encode("utf-8")
        _, _, raw = self.request("REPORT", calendar_url, body, {"Depth": "1", "Content-Type": "application/xml; charset=utf-8"})
        try:
            root = ET.fromstring(raw)
        except ET.ParseError:
            raise CalDAVError("CalDAV read-back returned invalid XML", retryable=True) from None
        response = root.find(f".//{{{DAV}}}response")
        status = response.find(f".//{{{DAV}}}status") if response is not None else None
        if response is None or status is None or " 200 " not in (status.text or ""):
            raise CalDAVError("CalDAV read-back did not find the event", retryable=True)
        etag = response.find(f".//{{{DAV}}}getetag")
        calendar_data = response.find(f".//{{{CALDAV}}}calendar-data")
        return (etag.text if etag is not None else None, (calendar_data.text or "").encode("utf-8") if calendar_data is not None else b"")

    def reconcile(self, intent: dict[str, Any], calendar_url: str) -> dict[str, Any]:
        remote_url = intent.get("remote_url") or self.resource_url(calendar_url, intent["event_uid"])
        if intent["desired_action"] == "delete":
            try:
                self.request("DELETE", remote_url, headers={"If-Match": intent.get("remote_etag") or "*"})
            except CalDAVError as error:
                if error.status != 404:
                    raise
            return {"status": "synced", "remoteUrl": remote_url, "etag": intent.get("remote_etag")}
        resource_uid = urllib.parse.unquote(remote_url.rsplit("/", 1)[-1]).removesuffix(".ics")
        data = render_event(intent, resource_uid)
        headers = {"Content-Type": "text/calendar; charset=utf-8", "If-Match": intent["remote_etag"]} if intent.get("remote_etag") else {"Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*"}
        try:
            _, response_headers, _ = self.request("PUT", remote_url, data, headers)
        except CalDAVError as error:
            if error.status == 412:
                current_etag, current = self.read_resource(calendar_url, remote_url)
                if current == data:
                    return {"status": "synced", "remoteUrl": remote_url, "etag": current_etag}
                _, response_headers, _ = self.request("PUT", remote_url, data, {"Content-Type": "text/calendar; charset=utf-8", "If-Match": current_etag or "*"})
            else:
                raise
        verify_etag, verify_data = self.read_resource(calendar_url, remote_url)
        if b"BEGIN:VEVENT" not in verify_data or resource_uid.encode("utf-8") not in verify_data:
            raise CalDAVError("CalDAV read-back verification failed", retryable=True)
        return {"status": "synced", "remoteUrl": remote_url, "etag": verify_etag or response_headers.get("etag")}


def main() -> int:
    request = json.load(sys.stdin)
    password = os.environ.get("MASHIROBOT_QQ_CALDAV_PASSWORD", "")
    if not password:
        raise CalDAVError("QQ CalDAV credential is missing", paused=True)
    client = QQCalDAVClient(request.get("endpoint", "https://dav.qq.com/"), request["account"], password)
    calendar_url = client.discover_calendar(request.get("calendarName", "Plan 计划"), request.get("calendarUrl"))
    if request.get("action") == "discover":
        result = {"status": "synced", "calendarUrl": calendar_url}
    else:
        result = client.reconcile(request["intent"], calendar_url)
        result["calendarUrl"] = calendar_url
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except CalDAVError as error:
        print(json.dumps({"status": "paused" if error.paused else "failed", "retryable": error.retryable, "error": str(error)}, ensure_ascii=False))
        raise SystemExit(2)
