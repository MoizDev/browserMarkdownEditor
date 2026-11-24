/* Compile-only declarations for the WASM32 callback boundary. There is no main
 * and no native API is executed. sizeof/offsetof are exported as build data by
 * Clang's record-layout dump, not guessed in a JavaScript adapter. */
#include "fpdfview.h"
#include "fpdf_formfill.h"
#include "fpdf_edit.h"
#include "fpdf_dataavail.h"
#include "fpdf_progressive.h"
#include "fpdf_save.h"
#include "fpdf_sysfontinfo.h"
_Static_assert(sizeof(void*) == 4, "WASM32 pointers required");
_Static_assert(sizeof(unsigned long) == 4, "WASM32 unsigned long required");
_Static_assert(sizeof(double) == 8, "64-bit double required");
_Static_assert(sizeof(FS_FLOAT) == 4, "32-bit FS_FLOAT required");
_Static_assert(__builtin_types_compatible_p(__typeof__(((FPDF_FILEACCESS*)0)->m_GetBlock), int (*)(void*, unsigned long, unsigned char*, unsigned long)), "Blob read callback ABI drift");
_Static_assert(__builtin_types_compatible_p(__typeof__(((FPDF_FILEWRITE*)0)->WriteBlock), int (*)(struct FPDF_FILEWRITE_*, const void*, unsigned long)), "Save callback ABI drift");
_Static_assert(__builtin_types_compatible_p(__typeof__(((IFSDK_PAUSE*)0)->NeedToPauseNow), FPDF_BOOL (*)(struct _IFSDK_PAUSE*)), "Pause callback ABI drift");
_Static_assert(__builtin_types_compatible_p(__typeof__(((FPDF_FORMFILLINFO*)0)->FFI_GetPage), FPDF_PAGE (*)(struct _FPDF_FORMFILLINFO*, FPDF_DOCUMENT, int)), "Form page callback ABI drift");
enum { library_size = sizeof(FPDF_LIBRARY_CONFIG), file_access_size = sizeof(FPDF_FILEACCESS), form_info_size = sizeof(FPDF_FORMFILLINFO), font_info_size = sizeof(FPDF_SYSFONTINFO), pause_size = sizeof(IFSDK_PAUSE), write_size = sizeof(FPDF_FILEWRITE), image_metadata_size = sizeof(FPDF_IMAGEOBJ_METADATA) };
