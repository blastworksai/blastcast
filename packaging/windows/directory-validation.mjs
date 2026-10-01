// CodexBWAI — one shared native directory probe, embedded in setup and its read-only test.
// 0 missing, 3 existing empty, 1 occupied/root/non-directory/reparse point, 2 inspection error.
export function directoryValidation() {
  return `Function DirectoryState
Exch $0
Push $1
Push $2
Push $3
Push $4
Push $5
Push $6
System::Call 'shlwapi::PathIsRootW(w r0) i.r1'
StrCmp $1 0 0 dir_occupied
System::Call 'kernel32::GetFileAttributesW(w r0) i.r1 ?e'
Pop $4
StrCmp $1 -1 dir_missing_check
IntOp $3 $1 & 16
StrCmp $3 0 dir_occupied
IntOp $3 $1 & 1024
StrCmp $3 0 0 dir_occupied
System::Alloc 592
Pop $5
StrCmp $5 0 dir_error
System::Call 'kernel32::FindFirstFileW(w "$0\\*", p r5) p.r2 ?e'
Pop $4
StrCmp $2 -1 dir_first_error
dir_entry:
IntOp $6 $5 + 44
System::Call '*$6(&w260 .r3)'
StrCmp $3 "." dir_next
StrCmp $3 ".." dir_next
StrCpy $0 1
Goto dir_close
dir_next:
System::Call 'kernel32::FindNextFileW(p r2, p r5) i.r1 ?e'
Pop $4
StrCmp $1 0 dir_end_check dir_entry
dir_end_check:
StrCmp $4 18 0 dir_iteration_error
StrCpy $0 3
Goto dir_close
dir_iteration_error:
StrCpy $0 2
dir_close:
System::Call 'kernel32::FindClose(p r2)'
System::Free $5
Goto dir_done
dir_first_error:
System::Free $5
StrCmp $4 2 dir_empty dir_error
dir_empty:
StrCpy $0 3
Goto dir_done
dir_missing_check:
StrCmp $4 2 dir_missing
StrCmp $4 3 dir_missing dir_error
dir_missing:
StrCpy $0 0
Goto dir_done
dir_occupied:
StrCpy $0 1
Goto dir_done
dir_error:
StrCpy $0 2
dir_done:
Pop $6
Pop $5
Pop $4
Pop $3
Pop $2
Pop $1
Exch $0
FunctionEnd
`;
}
