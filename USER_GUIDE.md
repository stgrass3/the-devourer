# The Devourer — User Guide

This guide explains The Devourer in everyday language. If you want build,
architecture, or implementation details, read the [technical README](README.md).

> [!WARNING]
> The Devourer permanently destroys the selected file. There is no recycle bin,
> undo button, or recovery feature. Double-check the file before you start.

## What is The Devourer?

The Devourer is a portable Windows app for permanently deleting one file at a
time. A normal delete usually removes the file's name while leaving its old data
on the drive until Windows reuses that space. The Devourer first replaces the
file's contents several times, then removes the file.

It is designed to make recovery harder, but no app can promise perfect erasure
on every kind of storage. SSDs, backups, cloud-sync history, snapshots, and
other copies can still keep data outside the original file.

## What you need

- A 64-bit Windows 10 or Windows 11 computer.
- The portable EXE from the project's [GitHub Releases page](https://github.com/stgrass3/the-devourer/releases).
- Administrator approval only if you choose **Aggressive** or **Extreme** mode.

The app is portable. You run the downloaded EXE directly; there is no installer
and no permanent background service.

## Before deleting anything

1. Make sure you selected the correct file.
2. Close any app that may be using it.
3. Check whether another copy exists in cloud storage, a backup, email, chat, or
   another folder.
4. Use **Normal** mode unless you understand why you need a stronger mode.
5. Keep the app open until it shows `100%` and confirms completion.

Test the app on an unimportant file first if you have never used it before.

## Delete a file step by step

1. Open `The-Devourer-1.0.3-portable-x64.exe`.
2. Choose a deletion mode. **Normal** is the right choice for most people.
3. Click the trash bin to open the file picker, or drag one file onto the app.
4. Read the displayed file name and warning carefully.
5. Click the armed trash bin again to start.
6. Do not close the app while the progress bar is moving.
7. Wait for `100%` and the completion message.

Selecting a file does not immediately delete it. The second click is the final
confirmation that starts permanent deletion.

## Which mode should I use?

| Mode | Best for | What it adds | Important note |
|---|---|---|---|
| **Normal** | Almost everyone | Four overwrite passes followed by deletion | No administrator access needed |
| **Aggressive** | Users who want Windows to retrim the drive afterward | Everything in Normal, plus a Windows drive optimization request | Requires administrator approval |
| **Extreme** | Special cases where wiping free space is worth the time and drive writes | Everything in Aggressive, plus filling most free space with temporary random data | Requires administrator approval and can take a very long time |

Extreme mode keeps roughly 512 MiB free so Windows is not intentionally filled
to absolute zero. It may still write a huge amount of data. Avoid it on an SSD
unless you accept the extra wear and understand that SSD hardware can keep
hidden copies internally.

If Windows asks for administrator approval, the app restarts after approval.
Choose the file again when it reopens.

## How deletion works, in simple terms

The Devourer uses several layers instead of relying on a normal delete:

1. **Checks the target.** It confirms the target is a regular file and refuses
   shortcuts, special filesystem links, and files with other hard-link names.
2. **Checks the drive.** It looks for storage conditions such as SSD/NVMe media,
   TRIM, BitLocker, and Volume Shadow Copies, then shows warnings where needed.
3. **Checks whether the file is busy.** If another program has it locked, The
   Devourer stops before changing anything.
4. **Finds hidden NTFS data streams.** Windows files can contain extra named data
   streams. The app attempts to process those as well as the main file data.
5. **Overwrites the data four times.** It writes all zeroes, all ones, secure
   random data, then zeroes again. Each pass covers the file from start to end.
6. **Flushes the writes.** It asks Windows to push the written data toward the
   storage device instead of leaving it only in memory.
7. **Hides the old name.** It replaces the original filename with a long random
   name and makes a best-effort attempt to clear common timestamps and recent-file
   shortcuts.
8. **Shrinks and removes the file.** It truncates the file to zero bytes, flushes
   once more, and removes the final filesystem entry.
9. **Runs the selected extra mode.** Aggressive requests ReTrim; Extreme also
   fills free space on the same drive with temporary random files and then
   removes them.

The progress display covers the destructive work. A completion message means
the app finished its planned steps; it does not mean every possible external or
hardware-managed copy has disappeared.

## Understanding the warnings

### SSD, NVMe, or TRIM warning

SSDs move data internally to spread wear. The app can overwrite the file Windows
shows it, but the drive may keep older physical pages that software cannot reach.
TRIM also lets the drive decide when erased blocks are physically cleared.

### BitLocker warning

BitLocker protects a drive while it is locked, but it does not turn a file wipe
into a guaranteed hardware-level erase. Encryption is still useful; the warning
simply avoids making a stronger promise than the app can prove.

### Volume Shadow Copy or snapshot warning

Windows snapshots can contain an older version of the file. Deleting the current
file does not automatically delete copies stored in snapshots.

### Locked-file warning

Another program is using the file. Close editors, players, preview windows,
sync tools, and any other app that may have the file open, then select it again.

### Hard-link warning

The same file data has more than one filename. The Devourer refuses to wipe only
one name while another name could still reach the same data.

### Symbolic-link or reparse-point warning

You selected a special link instead of a normal file. Select the real file
directly. The app deliberately does not follow these links for safety.

## What The Devourer can and cannot do

### It can

- Overwrite an ordinary local file and detected NTFS alternate data streams.
- Make recovery from the file's normal filesystem location more difficult.
- Warn about several common storage and backup risks.
- Refuse targets that would make deletion misleading or unsafe.
- Work locally without an account, telemetry, or a runtime cloud service.

### It cannot guarantee

- Removal of copies in OneDrive, Google Drive, Dropbox, email, chat, or backups.
- Removal of versions saved in Windows snapshots or other backup systems.
- Physical erasure of old pages hidden inside SSD or NVMe hardware.
- Removal of data previously copied to another drive or device.
- Removal of traces already recorded by another application or service.
- Perfect forensic erasure on every filesystem and storage device.

For whole-drive disposal or extremely sensitive data, use the drive maker's
secure-erase process, destroy the encryption keys where appropriate, or use a
qualified data-destruction service.

## Common problems

### The app says the file is locked

Close programs using the file. File Explorer's preview pane, antivirus software,
and sync clients can also hold files briefly. Wait a moment and try again.

### Aggressive or Extreme returns to Normal

Approve the Windows administrator prompt. After the app restarts, select your
mode and file again.

### Extreme mode is taking a long time

This is expected when the drive has lots of free space. Extreme may write nearly
all of that space. Keep the computer powered and the app open, or use Normal or
Aggressive mode for future files.

### Windows warns about an unknown publisher

The release executable is not code-signed. Download it only from the official
GitHub repository. You can compare its SHA-256 checksum with the value printed
on the release page before running it.

### The app reports an error

Read the message before retrying. Confirm the file still exists, is a regular
local file, is not locked, and that you have access to it. If the problem keeps
happening, open an issue on the [GitHub issue tracker](https://github.com/stgrass3/the-devourer/issues)
with the error text and the steps that produced it. Do not attach the sensitive
file itself.

## Privacy

The Devourer does not require an account and does not include application
telemetry. File processing happens on your computer. The portable package may
still be subject to normal Windows, antivirus, network, and organization-level
logging outside the app's control.

## Quick answers

**Can I recover a file after completion?**  
Do not assume so. The app is designed to make recovery difficult and provides
no undo feature.

**Can I delete a folder?**  
No. The current workflow accepts one regular file at a time.

**Should I always use Extreme?**  
No. Normal is appropriate for most files. Extreme can be slow, write heavily to
the drive, and still cannot guarantee erasure of SSD-managed copies.

**Does the app upload my file?**  
No. The deletion pipeline runs locally and has no runtime cloud API.

**Does the EXE need to be installed?**  
No. It is a portable executable.

**Where can I read the technical details?**  
See the [project README](README.md), especially its deletion pipeline, security
architecture, limitations, testing, and build sections.
