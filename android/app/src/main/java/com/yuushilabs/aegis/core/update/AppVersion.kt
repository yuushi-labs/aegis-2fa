package com.yuushilabs.aegis.core.update

/**
 * `1.1.2` や `1.1.2-beta1` のようなバージョンを、大小比較できる形にする。
 *
 * リリースのタグ（`v1.1.2`）と `BuildConfig.VERSION_NAME`（`1.1.1`）を同じ規則で読む。
 * 文字列比較だと `1.1.10` が `1.1.9` より小さくなるので、数字を分けて比べる。
 * 数字が同じなら、接尾辞なし（正式版）が接尾辞あり（プレリリース）より新しい。
 */
data class AppVersion(
    val numbers: List<Int>,
    /** 数字のあとの部分（`-beta1` など）。正式版は空文字。 */
    val suffix: String,
) : Comparable<AppVersion> {

    override fun compareTo(other: AppVersion): Int {
        val width = maxOf(numbers.size, other.numbers.size)
        for (index in 0 until width) {
            val mine = numbers.getOrElse(index) { 0 }
            val theirs = other.numbers.getOrElse(index) { 0 }
            if (mine != theirs) return mine.compareTo(theirs)
        }
        return compareSuffix(suffix, other.suffix)
    }

    /** 画面に出す形（`1.1.2` / `1.1.2-beta1`）。 */
    val display: String get() = numbers.joinToString(".") + suffix

    companion object {

        /**
         * タグ・リリース名・versionName のどれでも読める。先頭の `v` やリポジトリ名は
         * 最初の数字まで読み飛ばす（`aegis-android-1.1.2` も `1.1.2`）。
         * 数字が 2 つ以上ないもの（`build-12` や日付）はバージョンとして扱わない。
         */
        fun parse(raw: String?): AppVersion? {
            val text = raw?.trim().orEmpty()
            val start = text.indexOfFirst { it.isDigit() }
            if (start < 0) return null

            var index = start
            val numbers = ArrayList<Int>()
            while (true) {
                val numberStart = index
                while (index < text.length && text[index].isDigit()) index++
                if (numberStart == index) break
                numbers.add(text.substring(numberStart, index).toIntOrNull() ?: break)
                if (index < text.length && text[index] == '.' &&
                    index + 1 < text.length && text[index + 1].isDigit()
                ) {
                    index++
                } else {
                    break
                }
            }
            if (numbers.size < 2) return null
            return AppVersion(numbers, suffixFrom(text.substring(index)))
        }

        private fun suffixFrom(rest: String): String {
            val trimmed = rest.trim().trimStart('-', '_', '+', '.')
            return if (trimmed.isEmpty()) "" else "-$trimmed"
        }

        /**
         * 正式版 > プレリリース（`1.2.0` > `1.2.0-rc1`）。
         * 同じ段階名なら番号で比べる（`beta2` < `beta10`）。
         */
        private fun compareSuffix(mine: String, theirs: String): Int {
            val a = mine.trimStart('-')
            val b = theirs.trimStart('-')
            if (a.equals(b, ignoreCase = true)) return 0
            if (a.isEmpty()) return 1
            if (b.isEmpty()) return -1

            val minePrefix = a.takeWhile { !it.isDigit() }.lowercase()
            val theirsPrefix = b.takeWhile { !it.isDigit() }.lowercase()
            if (minePrefix != theirsPrefix) return minePrefix.compareTo(theirsPrefix)

            val mineNumber = a.drop(minePrefix.length).takeWhile { it.isDigit() }.toIntOrNull() ?: 0
            val theirsNumber = b.drop(theirsPrefix.length).takeWhile { it.isDigit() }.toIntOrNull() ?: 0
            if (mineNumber != theirsNumber) return mineNumber.compareTo(theirsNumber)
            return a.compareTo(b, ignoreCase = true)
        }
    }
}
