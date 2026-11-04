from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from ._tool_test_harness import SCRIPTS_DIR, build_env, run_tool

spec = importlib.util.spec_from_file_location("video_notes", SCRIPTS_DIR / "video_notes.py")
video = importlib.util.module_from_spec(spec)
spec.loader.exec_module(video)
YOUTUBE = "https://www.youtube.com/watch?v=aircAruvnKk"
BILIBILI = "https://www.bilibili.com/video/BV11t411A7vt/?p=2"
CAPTIONS = json.dumps({"events": [{"tStartMs": 1234, "dDurationMs": 2567, "segs": [{"utf8": "梯度 "}, {"utf8": "descent"}]}]})


class VideoNotesTests(unittest.TestCase):
    def setUp(self):
        self.info = {"id": "aircAruvnKk", "title": "Example", "duration": 20,
                     "webpage_url": YOUTUBE, "subtitles": {"en": [{"ext": "json3", "data": CAPTIONS}]},
                     "http_headers": {"Cookie": "PRIVATE_COOKIE"}, "description": "PRIVATE_DESCRIPTION"}
        self.downloader = MagicMock()
        self.downloader.__enter__.return_value = self.downloader
        self.downloader.extract_info.return_value = self.info
        self.factory = MagicMock(return_value=self.downloader)
        self.provider = SimpleNamespace(YoutubeDL=self.factory, version=SimpleNamespace(__version__="test"))
        self.patcher = patch.dict(sys.modules, {"yt_dlp": self.provider})
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_normalizes_single_video_and_preserves_bilibili_part(self):
        self.assertEqual(video.normalize_url("https://youtu.be/aircAruvnKk?si=tracking"), ("youtube", YOUTUBE))
        self.assertEqual(video.normalize_url(BILIBILI + "&share_source=copy"), ("bilibili", BILIBILI))
        for invalid in ("file:///tmp/video", "https://youtube.com.evil.test/watch?v=aircAruvnKk",
                        "https://youtube.com/playlist?list=abc", "https://x:secret@youtube.com/watch?v=aircAruvnKk",
                        "https://youtube.com/channel/aircAruvnKk", "https://youtu.be/extra/aircAruvnKk",
                        "https://bilibili.com/video/BV123/?p=0"):
            with self.subTest(invalid=invalid), self.assertRaises(video.VideoNotesError):
                video.normalize_url(invalid)

    def test_preserves_millisecond_cues_and_only_extracts_captions(self):
        source, raw, ext, cues = video.fetch_source(YOUTUBE, None, "chrome", None)
        self.assertEqual(cues, [{"id": "c000001", "start_ms": 1234, "end_ms": 3801, "text": "梯度 descent"}])
        self.assertEqual((raw, ext), (CAPTIONS, "json3"))
        self.downloader.extract_info.assert_called_once_with(YOUTUBE, download=False)
        self.downloader.download.assert_not_called()
        options = self.factory.call_args.args[0]
        self.assertTrue(options["skip_download"])
        self.assertTrue(options["noplaylist"])
        self.assertTrue(options["writesubtitles"])
        self.assertEqual(options["cookiesfrombrowser"], ("chrome",))
        self.assertNotIn("PRIVATE", json.dumps(source))

    def test_manual_preference_explicit_language_and_automatic_label(self):
        self.info["automatic_captions"] = {"en-orig": [{"ext": "json3", "data": CAPTIONS}]}
        self.info["subtitles"] = {"zh-CN": [{"ext": "srt", "data": "caption"}], "danmaku": [{"ext": "xml", "url": "https://example.test"}]}
        self.assertEqual(video.select_track(self.info, None)[:2], ("zh-CN", "manual"))
        self.assertEqual(video.select_track(self.info, "en")[:2], ("en-orig", "automatic"))
        with self.assertRaises(video.VideoNotesError) as failure:
            video.select_track(self.info, "ja")
        self.assertEqual(failure.exception.code, "language_unavailable")
        self.info["subtitles"] = {"ai-zh": [{"ext": "srt", "data": "caption"}]}
        self.assertEqual(video.select_track(self.info, "zh")[:2], ("ai-zh", "automatic"))

    def test_browser_profile_is_forwarded_without_exporting_cookies(self):
        video.fetch_source(YOUTUBE, None, "chrome:Profile 1", None)
        options = self.factory.call_args.args[0]
        self.assertEqual(options["cookiesfrombrowser"], ("chrome", "Profile 1"))
        self.assertNotIn("cookiefile", options)
        with self.assertRaises(video.VideoNotesError) as failure:
            video.fetch_source(YOUTUBE, None, "unknown", None)
        self.assertEqual(failure.exception.code, "unsupported_browser")

    def test_danmaku_and_auto_translations_are_not_caption_sources(self):
        info = {"subtitles": {"danmaku": [{"ext": "xml", "data": "comments"}]},
                "automatic_captions": {"en": [{"ext": "json3", "url": "https://example.test/captions?tlang=en"}]}}
        with self.assertRaises(video.VideoNotesError) as failure:
            video.select_track(info, None)
        self.assertEqual(failure.exception.code, "no_subtitles")

    def test_login_failure_is_distinct_from_no_captions(self):
        self.info["subtitles"] = {"danmaku": [{"ext": "xml", "data": "comments"}]}
        for warning, expected in ((None, "no_subtitles"), ("Subtitles are only available when logged in", "login_required"), ("Sign in to confirm you're not a bot", "platform_blocked")):
            def extract(*args, **kwargs):
                if warning:
                    self.factory.call_args.args[0]["logger"].warning(warning)
                return self.info
            self.downloader.extract_info.side_effect = extract
            with self.subTest(expected=expected), self.assertRaises(video.VideoNotesError) as failure:
                video.fetch_source(YOUTUBE, None, None, None)
            self.assertEqual(failure.exception.code, expected)

    def test_missing_subtitle_po_token_is_reported_as_access_failure(self):
        self.info["subtitles"] = {}
        messages = (
            "Some web client subtitles require a PO Token which was not provided. They will be discarded since they are not downloadable as-is.",
            "There are missing subtitles languages because a PO token was not provided. Subtitles for these languages are missing: en.",
        )
        for method, message, later_warning in (("warning", messages[0], None), ("debug", messages[0], None),
                                                ("warning", messages[1], None),
                                                ("debug", messages[1], "Some video formats returned HTTP Error 403")):
            def extract(*args, **kwargs):
                logger = self.factory.call_args.args[0]["logger"]
                getattr(logger, method)(message + " https://signed.test?secret=PRIVATE_TOKEN")
                if later_warning:
                    logger.warning(later_warning)
                return self.info
            self.downloader.extract_info.side_effect = extract
            with self.subTest(method=method, message=message), tempfile.TemporaryDirectory() as tmp:
                output = Path(tmp) / "source"
                with patch.object(sys, "argv", ["video-notes", "fetch", YOUTUBE, "-o", str(output)]), contextlib.redirect_stdout(io.StringIO()) as stdout:
                    self.assertEqual(video.main(), 1)
                result = json.loads(stdout.getvalue())
                self.assertEqual(result["error"]["code"], "po_token_required")
                self.assertNotIn("PRIVATE_TOKEN", stdout.getvalue())
                self.assertFalse(output.exists())

    def test_po_token_warning_does_not_discard_other_accessible_captions(self):
        def extract(*args, **kwargs):
            self.factory.call_args.args[0]["logger"].warning(
                "Some web client subtitles require a PO Token which was not provided.")
            return self.info
        self.downloader.extract_info.side_effect = extract
        source, _, _, cues = video.fetch_source(YOUTUBE, None, None, None)
        self.assertEqual(source["language"], "en")
        self.assertEqual(len(cues), 1)

    def test_cookie_debug_output_does_not_turn_missing_captions_into_login_failure(self):
        self.info["subtitles"] = {}
        def extract(*args, **kwargs):
            self.factory.call_args.args[0]["logger"].debug("Extracted 100 cookies from chrome")
            return self.info
        self.downloader.extract_info.side_effect = extract
        with self.assertRaises(video.VideoNotesError) as failure:
            video.fetch_source(YOUTUBE, None, None, None)
        self.assertEqual(failure.exception.code, "no_subtitles")

    def test_bilibili_media_segments_preserve_full_duration_and_part_captions(self):
        captions = json.dumps({"events": [{"tStartMs": 600000, "dDurationMs": 2000, "segs": [{"utf8": "Ending of the selected part"}]}]})
        self.info.update({"_type": "multi_video", "extractor_key": "BiliBili", "id": "BV11t411A7vt_p2",
                          "title": "Full selected part", "uploader": "Example author", "duration": 800,
                          "webpage_url": BILIBILI, "subtitles": None,
                          "entries": [{"id": "BV11t411A7vt_p2_0", "duration": 400,
                                       "subtitles": {"zh-CN": [{"ext": "json3", "data": captions}]}},
                                      {"id": "BV11t411A7vt_p2_1", "duration": 400, "subtitles": None}]})
        source, raw, _, cues = video.fetch_source(BILIBILI, None, None, None)
        self.assertEqual(source["video_id"], "BV11t411A7vt_p2")
        self.assertEqual(source["url"], BILIBILI)
        self.assertEqual(source["title"], "Full selected part")
        self.assertEqual(source["author"], "Example author")
        self.assertEqual(source["duration_ms"], 800000)
        self.assertEqual(raw, captions)
        self.assertEqual(cues[-1]["end_ms"], 602000)
        self.downloader.extract_info.assert_called_once_with(BILIBILI, download=False)
        with tempfile.TemporaryDirectory() as tmp:
            manifest = video.write_bundle(Path(tmp) / "source", source, raw, "json3", cues)
            self.assertIn("?p=2&t=600", Path(manifest["readable_transcript"]).read_text())

    def test_multi_video_support_does_not_accept_playlists_or_unrelated_segments(self):
        base = {**self.info, "_type": "multi_video", "extractor_key": "BiliBili", "id": "BV11t411A7vt_p2",
                "webpage_url": BILIBILI, "entries": [{"id": "BV11t411A7vt_p2_0", "subtitles": self.info["subtitles"]}]}
        for change in ({"_type": "playlist"}, {"extractor_key": "Youtube"}, {"entries": []},
                       {"entries": [None]}, {"entries": [{"id": "other_video_0", "subtitles": self.info["subtitles"]}]},
                       {"entries": [base["entries"][0], {"id": "other_video_1"}]}):
            self.downloader.extract_info.return_value = {**base, **change}
            with self.subTest(change=change), self.assertRaises(video.VideoNotesError) as failure:
                video.fetch_source(BILIBILI, None, None, None)
            self.assertEqual(failure.exception.code, "unsupported_url")

    def test_rejects_partial_metadata_playlists_and_bad_captions(self):
        for change, expected in (({"duration": 0}, "metadata_unavailable"), ({"_type": "playlist"}, "unsupported_url"), ({"is_live": True}, "live_video")):
            original = dict(self.info)
            self.info.update(change)
            with self.subTest(change=change), self.assertRaises(video.VideoNotesError) as failure:
                video.fetch_source(YOUTUBE, None, None, None)
            self.assertEqual(failure.exception.code, expected)
            self.info.clear()
            self.info.update(original)
        for raw in ('{}', '{"events": []}', '{"events":[{"tStartMs":-2,"dDurationMs":5,"segs":[{"utf8":"x"}]}]}'):
            with self.assertRaises(video.VideoNotesError):
                video.parse_captions(raw, "json3")

    def test_long_bundle_has_complete_chunks_part_links_and_no_overwrite(self):
        source, raw, ext, _ = video.fetch_source(YOUTUBE, None, None, None)
        source["url"] = BILIBILI
        cues = [{"id": f"c{i + 1:06d}", "start_ms": i * 2000 + 123, "end_ms": i * 2000 + 1900, "text": "源字幕 " * 60} for i in range(260)]
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "source"
            manifest = video.write_bundle(output, source, raw, ext, cues)
            self.assertGreater(len(manifest["chunks"]), 2)
            self.assertEqual(sum(chunk["cue_count"] for chunk in manifest["chunks"]), len(cues))
            chunk_text = "".join(Path(chunk["path"]).read_text() for chunk in manifest["chunks"])
            for cue in cues:
                self.assertEqual(chunk_text.count("[" + cue["id"] + " "), 1)
            self.assertIn("?p=2&t=0", chunk_text)
            self.assertIn("00:00:00.123", chunk_text)
            self.assertEqual(json.loads((output / "transcript.json").read_text())["cues"], cues)
            self.assertEqual((output / "captions.json3").read_text(), raw)
            self.assertEqual(hashlib.sha256((output / "captions.json3").read_bytes()).hexdigest(), source["caption_sha256"])
            with self.assertRaises(video.VideoNotesError) as failure:
                video.write_bundle(output, source, "changed", ext, cues)
            self.assertEqual(failure.exception.code, "output_exists")
            self.assertEqual((output / "captions.json3").read_text(), raw)

    def test_provider_error_is_nonzero_json_without_secrets_or_output(self):
        self.downloader.extract_info.side_effect = RuntimeError("HTTP Error 403 PRIVATE_COOKIE https://signed.test?secret=TOKEN")
        with tempfile.TemporaryDirectory() as tmp, patch.object(sys, "argv", ["video-notes", "fetch", YOUTUBE, "-o", str(Path(tmp) / "source")]):
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                status = video.main()
            result = json.loads(stdout.getvalue())
            self.assertEqual(status, 1)
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"]["code"], "platform_blocked")
            self.assertNotIn("PRIVATE", stdout.getvalue())
            self.assertNotIn("TOKEN", stdout.getvalue())
            self.assertFalse((Path(tmp) / "source").exists())

    def test_citation_check_catches_wrong_times_videos_ids_and_missing_evidence(self):
        source, raw, ext, cues = video.fetch_source(YOUTUBE, None, None, None)
        good = f"A claim [00:01 · c000001]({YOUTUBE}&t=1)"
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = video.write_bundle(root / "source", source, raw, ext, cues)
            note = root / "notes.md"
            for content in (good, good.replace("00:01", "00:02"), good.replace("t=1", "t=7"),
                            good.replace("c000001", "c999999"), good.replace("aircAruvnKk", "abcdefghijk"), "Uncited summary"):
                note.write_text(content)
                result = video.verify_notes(Path(manifest["transcript"]), [note])
                self.assertEqual(result["ok"], content == good, content)
                self.assertEqual(note.read_text(), content)
            note.write_text(good.replace("t=1", "t=7"))
            with patch.object(sys, "argv", ["video-notes", "verify", manifest["transcript"], str(note)]), contextlib.redirect_stdout(io.StringIO()) as stdout:
                self.assertEqual(video.main(), 1)
                self.assertEqual(json.loads(stdout.getvalue())["error"]["code"], "citation_mismatch")

    def test_citation_check_rejects_unchecked_occurrences_even_after_a_valid_citation(self):
        source, raw, ext, cues = video.fetch_source(YOUTUBE, None, None, None)
        good = f"A claim [00:01 · c000001]({YOUTUBE}&t=1)"
        # Reuse the same cue ID: checking IDs as a set would still miss these occurrences.
        unchecked = (f"Another [09:59 · c000001][clip]\n\n[clip]: {YOUTUBE}&t=599",
                     "Another [09:59 · c000001](source/transcript.md#c000001)",
                     "Another 09:59 · c000001", "引用c000001", f"Another [09:59 · c000001]({YOUTUBE}&t=599",
                     f"Another [00:01 · c000001][clip]\n\n[clip]: {YOUTUBE}&t=1")
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifest = video.write_bundle(root / "source", source, raw, ext, cues)
            note = root / "notes.md"
            for extra in unchecked:
                content = good + "\n" + extra
                note.write_text(content)
                with self.subTest(extra=extra), patch.object(sys, "argv", ["video-notes", "verify", manifest["transcript"], str(note)]), contextlib.redirect_stdout(io.StringIO()) as stdout:
                    self.assertEqual(video.main(), 1)
                    result = json.loads(stdout.getvalue())
                    self.assertTrue(any(issue["problem"] == "unsupported_citation_format" for issue in result["issues"]))
                    self.assertEqual(note.read_text(), content)
            note.write_text(good + "\n" + good)
            result = video.verify_notes(Path(manifest["transcript"]), [note])
            self.assertTrue(result["ok"])
            self.assertEqual(result["files"][0]["citations"], 2)


class VideoNotesSmokeTests(unittest.TestCase):
    def test_bundled_wrapper_help_and_invalid_url(self):
        help_result = run_tool("video-notes", "fetch", "--help")
        self.assertEqual(help_result.returncode, 0, help_result.stderr)
        self.assertIn("--cookies-from-browser", help_result.stdout)
        with tempfile.TemporaryDirectory() as tmp:
            invalid = run_tool("video-notes", "fetch", "https://example.com/video", "-o", str(Path(tmp) / "source"))
            self.assertEqual(invalid.returncode, 1, invalid.stderr)
            self.assertEqual(json.loads(invalid.stdout)["error"]["code"], "unsupported_url")

    def test_real_subtitle_library_preserves_srt_and_vtt_precision(self):
        env = build_env()
        code = '''import runpy, sys
parse = runpy.run_path(sys.argv[1])["parse_captions"]
for ext, raw in [("srt", "1\\n00:00:01,234 --> 00:00:03,801\\n<b>梯度</b> descent\\n"), ("vtt", "WEBVTT\\n\\n00:01.234 --> 00:03.801\\n梯度 descent\\n")]:
    cues = parse(raw, ext)
    assert cues == [{"id": "c000001", "start_ms": 1234, "end_ms": 3801, "text": "梯度 descent"}], cues
'''
        result = subprocess.run([env["CRAFT_UV"], "run", "--python", "3.12", "--with", "pysubs2==1.9.1", "python", "-c", code, str(SCRIPTS_DIR / "video_notes.py")], capture_output=True, text=True, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
