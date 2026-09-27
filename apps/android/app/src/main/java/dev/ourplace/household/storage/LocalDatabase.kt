package dev.ourplace.household.storage

import android.content.Context
import androidx.room.*
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase

@Entity(tableName = "drafts", indices = [Index("clientId", "state")])
data class DraftRow(
    @PrimaryKey val draftId: String, val clientId: String, val scopeId: String, val text: String,
    val createdAt: Long, val revision: Int = 1, val state: String = "DRAFT",
    val sourceJson: String = "{\"kind\":\"typed\"}", val attachmentsJson: String = "[]",
    val frozenJson: String? = null, val frozenHash: String? = null, val outcomeJson: String? = null,
    val settled: Boolean = false,
    @ColumnInfo(defaultValue = "'inbox'") val category: String = "inbox"
)
@Entity(tableName = "media", indices = [Index("clientId")])
data class MediaRow(@PrimaryKey val mediaId: String, val clientId: String, val path: String, val digest: String, val byteLength: Long, val mimeType: String)
@Entity(tableName = "attempts", indices = [Index("clientId")])
data class AttemptRow(@PrimaryKey val key: String, val clientId: String, val recordId: String, val kind: String, val frozenJson: String, val outcomeJson: String? = null,
    val attachmentDraftId: String? = null, val uploadsJson: String? = null)
@Entity(tableName = "attachment_drafts", indices = [Index(value = ["clientId", "recordId"], unique = true)])
data class AttachmentDraftRow(@PrimaryKey val draftId: String, val clientId: String, val recordId: String, val scopeId: String,
    val baseRevision: Int, val serverEpoch: String, val revision: Int = 1, val attachmentsJson: String = "[]",
    val localMediaIdsJson: String = "[]", val state: String = "DRAFT", val operationId: String? = null, val outcomeJson: String? = null)
@Entity(tableName = "values")
data class ValueRow(@PrimaryKey val key: String, val value: String)
@Entity(tableName = "acquisitions", indices = [Index("clientId")])
data class AcquisitionRow(@PrimaryKey val acquisitionId: String, val clientId: String, val draftId: String, val path: String, val kind: String, val state: String, val createdAt: Long,
    @ColumnInfo(defaultValue = "'inbox'") val targetKind: String = "inbox")

@Dao
interface LocalDao {
    @Query("SELECT * FROM attachment_drafts WHERE draftId=:id") fun attachmentDraft(id: String): AttachmentDraftRow?
    @Query("SELECT * FROM attachment_drafts WHERE clientId=:clientId AND recordId=:recordId") fun attachmentDraftFor(clientId: String, recordId: String): AttachmentDraftRow?
    @Insert(onConflict = OnConflictStrategy.ABORT) fun insertAttachmentDraft(row: AttachmentDraftRow)
    @Update fun updateAttachmentDraft(row: AttachmentDraftRow)
    @Query("DELETE FROM attachment_drafts WHERE draftId=:id AND state<>'SUBMITTED'") fun deleteAttachmentDraft(id: String): Int
    @Query("SELECT * FROM drafts WHERE draftId=:id") fun draft(id: String): DraftRow?
    @Query("SELECT * FROM drafts WHERE clientId=:clientId ORDER BY createdAt,draftId") fun drafts(clientId: String): List<DraftRow>
    @Insert(onConflict = OnConflictStrategy.ABORT) fun insertDraft(row: DraftRow)
    @Update fun updateDraft(row: DraftRow)
    @Query("DELETE FROM drafts WHERE draftId=:id AND state='DRAFT'") fun deleteDraft(id: String): Int
    @Query("SELECT * FROM media WHERE mediaId=:id") fun media(id: String): MediaRow?
    @Insert(onConflict = OnConflictStrategy.ABORT) fun insertMedia(row: MediaRow)
    @Query("DELETE FROM media WHERE mediaId=:id") fun deleteMedia(id: String)
    @Query("SELECT * FROM attempts WHERE `key`=:key") fun attempt(key: String): AttemptRow?
    @Query("SELECT * FROM attempts WHERE clientId=:clientId AND outcomeJson IS NULL") fun pendingAttempts(clientId: String): List<AttemptRow>
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun putAttempt(row: AttemptRow)
    @Query("SELECT value FROM `values` WHERE `key`=:key") fun value(key: String): String?
    @Insert(onConflict = OnConflictStrategy.REPLACE) fun putValue(row: ValueRow)
    @Query("DELETE FROM `values` WHERE `key`=:key") fun deleteValue(key: String)
    @Insert(onConflict = OnConflictStrategy.ABORT) fun insertAcquisition(row: AcquisitionRow)
    @Query("SELECT * FROM acquisitions WHERE acquisitionId=:id") fun acquisition(id: String): AcquisitionRow?
    @Query("SELECT * FROM acquisitions WHERE clientId=:clientId AND state='pending'") fun pendingAcquisitions(clientId: String): List<AcquisitionRow>
    @Update fun updateAcquisition(row: AcquisitionRow)
}

@Database(entities = [DraftRow::class, MediaRow::class, AttemptRow::class, ValueRow::class, AcquisitionRow::class, AttachmentDraftRow::class], version = 3, exportSchema = true)
abstract class LocalDatabase : RoomDatabase() {
    abstract fun dao(): LocalDao
    companion object {
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE drafts ADD COLUMN category TEXT NOT NULL DEFAULT 'inbox'")
            }
        }
        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE attempts ADD COLUMN attachmentDraftId TEXT")
                db.execSQL("ALTER TABLE attempts ADD COLUMN uploadsJson TEXT")
                db.execSQL("ALTER TABLE acquisitions ADD COLUMN targetKind TEXT NOT NULL DEFAULT 'inbox'")
                db.execSQL("CREATE TABLE attachment_drafts (draftId TEXT NOT NULL PRIMARY KEY, clientId TEXT NOT NULL, recordId TEXT NOT NULL, scopeId TEXT NOT NULL, baseRevision INTEGER NOT NULL, serverEpoch TEXT NOT NULL, revision INTEGER NOT NULL, attachmentsJson TEXT NOT NULL, localMediaIdsJson TEXT NOT NULL, state TEXT NOT NULL, operationId TEXT, outcomeJson TEXT)")
                db.execSQL("CREATE UNIQUE INDEX index_attachment_drafts_clientId_recordId ON attachment_drafts(clientId,recordId)")
            }
        }
        fun open(context: Context, name: String = "household-client.sqlite"): LocalDatabase = Room.databaseBuilder(context, LocalDatabase::class.java, name)
            .setJournalMode(JournalMode.WRITE_AHEAD_LOGGING)
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3)
            .addCallback(object : Callback() {
                override fun onOpen(db: SupportSQLiteDatabase) {
                    // A locally confirmed capture must survive process loss before WorkManager runs.
                    db.execSQL("PRAGMA synchronous=FULL")
                }
            }).build()
        // No destructive-migration fallback: future versions must preserve frozen requests.
    }
}
