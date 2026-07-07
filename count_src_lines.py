"""统计 src 目录下所有文件的代码行数"""
import os
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parent / "src"

# 要统计的文件扩展名
CODE_EXTS = {".ts", ".js", ".json", ".md"}


def count_lines(filepath: Path) -> int:
    """统计单个文件的行数（排除空行）"""
    try:
        with open(filepath, encoding="utf-8") as f:
            return sum(1 for line in f if line.strip())
    except Exception:
        return 0


def main():
    total_lines = 0
    total_files = 0
    by_ext: dict[str, tuple[int, int]] = {}  # ext -> (files, lines)

    for root, _dirs, files in os.walk(SRC_DIR):
        for name in files:
            fp = Path(root) / name
            ext = fp.suffix.lower()
            if ext not in CODE_EXTS:
                continue
            lines = count_lines(fp)
            total_lines += lines
            total_files += 1
            prev = by_ext.get(ext, (0, 0))
            by_ext[ext] = (prev[0] + 1, prev[1] + lines)

    print(f"src 目录统计（非空行）")
    print(f"{'=' * 40}")
    for ext in sorted(by_ext):
        files, lines = by_ext[ext]
        print(f"  {ext:6s}  {files:4d} 个文件  {lines:6d} 行")
    print(f"{'=' * 40}")
    print(f"  合计    {total_files:4d} 个文件  {total_lines:6d} 行")


if __name__ == "__main__":
    main()
