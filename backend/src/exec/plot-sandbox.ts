export const PLOT_REQUIRED_PACKAGES = [
  'matplotlib',
  'numpy',
  'pandas',
  'seaborn',
] as const;

export const PLOT_PACKAGE_DIRECTORY_NAME = 'python-plot-packages';
export const PLOT_RUN_DIRECTORY_NAME = 'plot-runs';
export const PLOT_CODE_FILENAME = 'plot_code.py';
export const PLOT_RUNNER_FILENAME = 'plot_runner.py';
export const PLOT_METADATA_FILENAME = 'plot-result.json';
export const PLOT_INSTALL_TIMEOUT_MS = 480_000;
export const PLOT_DRAFT_DPI = 72;
export const PLOT_FINAL_DPI = 220;
export const PLOT_SMALL_TEXT_THRESHOLD_PT = 8;

export function getPlotRunnerScript(): string {
  return `
import json
import os
import sys
import traceback
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns

plt.style.use("seaborn-v0_8-whitegrid")
sns.set_theme(context="talk", style="whitegrid")

output_dir = Path(os.environ["GRAPH_PLOT_OUTPUT_DIR"])
code_path = Path(os.environ["GRAPH_PLOT_CODE_PATH"])
metadata_path = output_dir / "${PLOT_METADATA_FILENAME}"
render_dpi = int(os.environ.get("GRAPH_PLOT_RENDER_DPI", "${PLOT_DRAFT_DPI}"))
small_text_threshold = float(os.environ.get("GRAPH_PLOT_SMALL_TEXT_THRESHOLD_PT", "${PLOT_SMALL_TEXT_THRESHOLD_PT}"))

globals_dict = {
    "__name__": "__main__",
    "plt": plt,
    "np": np,
    "pd": pd,
    "sns": sns,
    "Path": Path,
}


def append_visible_text(target, artist):
    if artist is None:
        return

    try:
        text_value = artist.get_text()
        is_visible = artist.get_visible()
    except Exception:
        return

    if not is_visible or not str(text_value).strip():
        return

    target.append(artist)


def collect_text_artists(figure):
    artists = []
    append_visible_text(artists, getattr(figure, "_suptitle", None))
    append_visible_text(artists, getattr(figure, "_supxlabel", None))
    append_visible_text(artists, getattr(figure, "_supylabel", None))

    for artist in figure.texts:
        append_visible_text(artists, artist)

    for axis in figure.axes:
        append_visible_text(artists, axis.title)
        append_visible_text(artists, axis.xaxis.label)
        append_visible_text(artists, axis.yaxis.label)

        for label in axis.get_xticklabels():
            append_visible_text(artists, label)

        for label in axis.get_yticklabels():
            append_visible_text(artists, label)

        for artist in axis.texts:
            append_visible_text(artists, artist)

        legend = axis.get_legend()
        if legend is not None:
            append_visible_text(artists, legend.get_title())
            for artist in legend.get_texts():
                append_visible_text(artists, artist)

    unique_artists = []
    seen_ids = set()
    for artist in artists:
        artist_id = id(artist)
        if artist_id in seen_ids:
            continue
        seen_ids.add(artist_id)
        unique_artists.append(artist)

    return unique_artists


def bbox_overlaps(first_bbox, second_bbox):
    return not (
        first_bbox.x1 <= second_bbox.x0
        or second_bbox.x1 <= first_bbox.x0
        or first_bbox.y1 <= second_bbox.y0
        or second_bbox.y1 <= first_bbox.y0
    )


def collect_layout_diagnostics(figure, artifact_filename):
    figure.canvas.draw()
    renderer = figure.canvas.get_renderer()
    figure_bbox = figure.bbox
    text_artists = collect_text_artists(figure)
    text_boxes = []
    font_sizes = []
    clipped_text_count = 0
    very_small_text_count = 0

    for artist in text_artists:
        try:
            bbox = artist.get_window_extent(renderer)
        except Exception:
            continue

        if bbox.width <= 0 or bbox.height <= 0:
            continue

        font_size = float(artist.get_fontsize())
        font_sizes.append(font_size)
        if font_size < small_text_threshold:
            very_small_text_count += 1

        if (
            bbox.x0 < figure_bbox.x0 - 1
            or bbox.y0 < figure_bbox.y0 - 1
            or bbox.x1 > figure_bbox.x1 + 1
            or bbox.y1 > figure_bbox.y1 + 1
        ):
            clipped_text_count += 1

        text_boxes.append(bbox)

    overlapping_text_pair_count = 0
    for index, first_bbox in enumerate(text_boxes):
        for second_bbox in text_boxes[index + 1 :]:
            if bbox_overlaps(first_bbox, second_bbox):
                overlapping_text_pair_count += 1

    return {
        "filename": artifact_filename,
        "widthPx": int(round(figure_bbox.width)),
        "heightPx": int(round(figure_bbox.height)),
        "axesCount": len(figure.axes),
        "textElementCount": len(text_artists),
        "visibleTextElementCount": len(text_boxes),
        "clippedTextCount": clipped_text_count,
        "overlappingTextPairCount": overlapping_text_pair_count,
        "verySmallTextCount": very_small_text_count,
        "minFontSize": round(min(font_sizes), 2) if font_sizes else None,
        "maxFontSize": round(max(font_sizes), 2) if font_sizes else None,
        "averageFontSize": round(sum(font_sizes) / len(font_sizes), 2)
        if font_sizes
        else None,
    }


def summarize_layout_diagnostics(figure_diagnostics):
    return {
        "totalFigureCount": len(figure_diagnostics),
        "totalAxesCount": sum(item["axesCount"] for item in figure_diagnostics),
        "totalTextElementCount": sum(item["textElementCount"] for item in figure_diagnostics),
        "totalVisibleTextElementCount": sum(
            item["visibleTextElementCount"] for item in figure_diagnostics
        ),
        "totalClippedTextCount": sum(item["clippedTextCount"] for item in figure_diagnostics),
        "totalOverlappingTextPairCount": sum(
            item["overlappingTextPairCount"] for item in figure_diagnostics
        ),
        "totalVerySmallTextCount": sum(item["verySmallTextCount"] for item in figure_diagnostics),
        "figures": figure_diagnostics,
    }

try:
    source = code_path.read_text(encoding="utf-8")
    exec(compile(source, str(code_path), "exec"), globals_dict)

    figure_numbers = plt.get_fignums()
    if not figure_numbers:
        raise RuntimeError(
            "Plot code did not create any matplotlib figures. Create a figure with plt.figure(), plt.subplots(), or pyplot plotting calls."
        )

    artifacts = []
    layout_diagnostics = []
    for index, figure_number in enumerate(figure_numbers, start=1):
        figure = plt.figure(figure_number)
        output_path = output_dir / f"figure-{index}.png"
        figure.tight_layout()
        layout_diagnostics.append(collect_layout_diagnostics(figure, output_path.name))
        figure.savefig(output_path, dpi=render_dpi, bbox_inches="tight")
        artifacts.append(
            {
                "filename": output_path.name,
                "mimeType": "image/png",
                "dpi": render_dpi,
            }
        )

    metadata_path.write_text(
        json.dumps(
            {
                "artifacts": artifacts,
                "layoutDiagnostics": summarize_layout_diagnostics(layout_diagnostics),
            }
        ),
        encoding="utf-8",
    )
    print(json.dumps({"status": "ok", "artifactCount": len(artifacts)}))
except Exception:
    traceback.print_exc()
    sys.exit(1)
finally:
    plt.close("all")
`.trim();
}
