package org.crabcore.u1control.slicing

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

/**
 * Applies a U1 preparation plan to a downloaded 3MF.
 *
 * A MakerWorld 3MF is a Bambu Studio project: its
 * [Metadata/project_settings.config] describes another machine's bed, build
 * height, motion limits and start/end G-code. `CLAUDE.md` forbids any of that
 * reaching the U1.
 *
 * **This object carries no policy.** It reads the config out, and writes back
 * exactly the keys it is told to set, delete or drop. Deciding *which* keys
 * those are belongs to `services/prepare/U1ProjectPreparer.ts`, where the rules
 * are covered by the repository's test suite rather than only by slicing
 * something and inspecting the result. The split matches
 * [SliceSettings3mfPatcher], which does the same mechanical job for the prepare
 * screen's overrides.
 */
object U1ProjectRewriter {
  private const val PROJECT_SETTINGS = "Metadata/project_settings.config"

  /** The project config as JSON text, or null when the archive has none. */
  fun readProjectSettings(file: File): String? {
    if (!file.exists()) return null
    return runCatching {
      ZipFile(file).use { zip ->
        val entry = zip.entries().asSequence().firstOrNull {
          it.name.equals(PROJECT_SETTINGS, ignoreCase = true)
        } ?: return null
        zip.getInputStream(entry).bufferedReader().use { it.readText() }
      }
    }.getOrNull()
  }

  /**
   * Writes [source] to [out] with the plan applied.
   *
   * The project config is rebuilt rather than patched in place: `apply` wins
   * over whatever the download said, `remove` is deleted, and `removeEntries`
   * names archive members to drop entirely — the foreign machine's sliced
   * G-code, which must not survive retargeting.
   *
   * A source with no project config still gets one, because the plan carries the
   * U1's identity and a file that names no machine would leave the engine to
   * fall back on a default.
   */
  fun rewrite(source: File, out: File, planJson: String): Boolean {
    val plan = JSONObject(planJson)
    val apply = plan.optJSONObject("apply") ?: JSONObject()
    val remove = plan.optJSONArray("remove").toStringSet()
    val removeEntries = plan.optJSONArray("removeEntries").toStringSet()

    ZipFile(source).use { zip ->
      val existing = zip.entries().asSequence().firstOrNull {
        it.name.equals(PROJECT_SETTINGS, ignoreCase = true)
      }
      val merged = existing
        ?.let { entry ->
          runCatching {
            JSONObject(zip.getInputStream(entry).bufferedReader().use { it.readText() })
          }.getOrDefault(JSONObject())
        }
        ?: JSONObject()

      for (key in remove) merged.remove(key)
      for (key in apply.keys()) merged.put(key, apply.get(key))
      val payload = merged.toString(2).toByteArray(Charsets.UTF_8)

      ZipOutputStream(FileOutputStream(out).buffered()).use { dest ->
        zip.entries().asIterator().forEach { item ->
          if (item.name.equals(PROJECT_SETTINGS, ignoreCase = true)) return@forEach
          if (removeEntries.any { it.equals(item.name, ignoreCase = true) }) return@forEach
          dest.putNextEntry(ZipEntry(item.name))
          if (!item.isDirectory) {
            zip.getInputStream(item).use { input -> input.copyTo(dest) }
          }
          dest.closeEntry()
        }
        dest.putNextEntry(ZipEntry(PROJECT_SETTINGS))
        dest.write(payload)
        dest.closeEntry()
      }
    }
    return out.exists() && out.length() > 0L
  }

  private fun JSONArray?.toStringSet(): Set<String> {
    if (this == null) return emptySet()
    val out = LinkedHashSet<String>(length())
    for (index in 0 until length()) {
      val value = optString(index, "")
      if (value.isNotEmpty()) out.add(value)
    }
    return out
  }
}
