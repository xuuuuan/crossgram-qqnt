#define _GNU_SOURCE
#include <dlfcn.h>

typedef void *(*ppapi_dispatch_fn)(const char *filename, int flags, void *caller);
typedef void *(*glibc_dlopen_fn)(const char *filename, int flags);
ppapi_dispatch_fn ppapi_dispatch_ptr;

__attribute__((visibility("default")))
void *ppapi_dlopen_impl(const char *filename, int flags) {
  if (ppapi_dispatch_ptr != 0)
    return ppapi_dispatch_ptr(filename, flags, __builtin_return_address(0));
  glibc_dlopen_fn forward = (glibc_dlopen_fn)dlvsym(RTLD_NEXT, "dlopen", "GLIBC_2.2.5");
  return forward == 0 ? 0 : forward(filename, flags);
}

__asm__(".symver ppapi_dlopen_impl,dlopen@@GLIBC_2.2.5");
