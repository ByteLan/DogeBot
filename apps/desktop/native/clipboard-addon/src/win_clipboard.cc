#include <node_api.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#endif

namespace {

struct ClipboardItem {
  std::string type_utf8;
  std::vector<uint8_t> data;
#ifdef _WIN32
  std::wstring type_wide;
#endif
};

void Check(napi_env env, napi_status status, const char* message) {
  if (status == napi_ok) return;
  const napi_extended_error_info* info = nullptr;
  napi_get_last_error_info(env, &info);
  std::string detail = info && info->error_message ? info->error_message : "unknown napi error";
  throw std::runtime_error(std::string(message) + ": " + detail);
}

std::string GetString(napi_env env, napi_value value, const char* field_name) {
  napi_valuetype value_type = napi_undefined;
  Check(env, napi_typeof(env, value, &value_type), "napi_typeof failed");
  if (value_type != napi_string) {
    throw std::runtime_error(std::string(field_name) + " must be a string");
  }

  size_t length = 0;
  Check(env, napi_get_value_string_utf8(env, value, nullptr, 0, &length), "napi_get_value_string_utf8 length failed");
  std::vector<char> buffer(length + 1, '\0');
  Check(env, napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length), "napi_get_value_string_utf8 failed");
  return std::string(buffer.data(), length);
}

std::vector<uint8_t> GetByteData(napi_env env, napi_value value) {
  bool is_buffer = false;
  Check(env, napi_is_buffer(env, value, &is_buffer), "napi_is_buffer failed");
  if (is_buffer) {
    void* raw = nullptr;
    size_t length = 0;
    Check(env, napi_get_buffer_info(env, value, &raw, &length), "napi_get_buffer_info failed");
    const auto* bytes = static_cast<const uint8_t*>(raw);
    if (length == 0) return {};
    return std::vector<uint8_t>(bytes, bytes + length);
  }

  bool is_typed_array = false;
  Check(env, napi_is_typedarray(env, value, &is_typed_array), "napi_is_typedarray failed");
  if (!is_typed_array) {
    throw std::runtime_error("data must be a Buffer or Uint8Array");
  }

  napi_typedarray_type array_type;
  size_t length = 0;
  void* raw = nullptr;
  napi_value array_buffer;
  size_t byte_offset = 0;
  Check(
    env,
    napi_get_typedarray_info(env, value, &array_type, &length, &raw, &array_buffer, &byte_offset),
    "napi_get_typedarray_info failed"
  );
  if (array_type != napi_uint8_array && array_type != napi_uint8_clamped_array) {
    throw std::runtime_error("data typed array must be Uint8Array");
  }
  const auto* bytes = static_cast<const uint8_t*>(raw);
  if (length == 0) return {};
  return std::vector<uint8_t>(bytes, bytes + length);
}

#ifdef _WIN32

std::string Win32ErrorMessage(const std::string& prefix, DWORD code = GetLastError()) {
  char* raw_message = nullptr;
  const DWORD flags = FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS;
  const DWORD length = FormatMessageA(flags, nullptr, code, 0, reinterpret_cast<char*>(&raw_message), 0, nullptr);
  std::string detail = length && raw_message ? raw_message : "unknown Windows error";
  if (raw_message) LocalFree(raw_message);
  while (!detail.empty() && (detail.back() == '\r' || detail.back() == '\n' || detail.back() == '.')) {
    detail.pop_back();
  }
  return prefix + " (" + std::to_string(code) + "): " + detail;
}

std::wstring Utf8ToWide(const std::string& value) {
  if (value.empty()) return L"";
  const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
  if (required <= 0) {
    throw std::runtime_error(Win32ErrorMessage("invalid UTF-8 clipboard format name"));
  }

  std::wstring result(static_cast<size_t>(required), L'\0');
  const int written = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), result.data(), required);
  if (written != required) {
    throw std::runtime_error(Win32ErrorMessage("UTF-8 clipboard format conversion failed"));
  }
  return result;
}

void OpenClipboardWithRetry() {
  for (int attempt = 0; attempt < 30; ++attempt) {
    if (OpenClipboard(nullptr)) return;
    Sleep(static_cast<DWORD>(10 + attempt * 5));
  }
  throw std::runtime_error(Win32ErrorMessage("OpenClipboard failed"));
}

class ClipboardSession {
 public:
  ClipboardSession() {
    OpenClipboardWithRetry();
    opened_ = true;
  }

  ~ClipboardSession() {
    if (opened_) CloseClipboard();
  }

  ClipboardSession(const ClipboardSession&) = delete;
  ClipboardSession& operator=(const ClipboardSession&) = delete;

 private:
  bool opened_ = false;
};

void WriteCustomFormatsToClipboard(const std::vector<ClipboardItem>& items) {
  ClipboardSession session;
  if (!EmptyClipboard()) {
    throw std::runtime_error(Win32ErrorMessage("EmptyClipboard failed"));
  }

  for (const auto& item : items) {
    if (item.type_wide.empty()) {
      throw std::runtime_error("clipboard format name cannot be empty");
    }

    const UINT format = RegisterClipboardFormatW(item.type_wide.c_str());
    if (format == 0) {
      throw std::runtime_error(Win32ErrorMessage("RegisterClipboardFormatW failed for " + item.type_utf8));
    }

    const SIZE_T byte_count = static_cast<SIZE_T>(std::max<size_t>(item.data.size(), 1));
    HGLOBAL handle = GlobalAlloc(GMEM_MOVEABLE, byte_count);
    if (!handle) {
      throw std::runtime_error(Win32ErrorMessage("GlobalAlloc failed for " + item.type_utf8));
    }

    void* locked = GlobalLock(handle);
    if (!locked) {
      GlobalFree(handle);
      throw std::runtime_error(Win32ErrorMessage("GlobalLock failed for " + item.type_utf8));
    }

    if (!item.data.empty()) {
      std::memcpy(locked, item.data.data(), item.data.size());
    } else {
      std::memset(locked, 0, 1);
    }

    SetLastError(ERROR_SUCCESS);
    if (!GlobalUnlock(handle) && GetLastError() != ERROR_SUCCESS) {
      const std::string message = Win32ErrorMessage("GlobalUnlock failed for " + item.type_utf8);
      GlobalFree(handle);
      throw std::runtime_error(message);
    }

    if (!SetClipboardData(format, handle)) {
      const std::string message = Win32ErrorMessage("SetClipboardData failed for " + item.type_utf8);
      GlobalFree(handle);
      throw std::runtime_error(message);
    }

    handle = nullptr;
  }
}

#endif

std::vector<ClipboardItem> ParseItems(napi_env env, napi_value value) {
  bool is_array = false;
  Check(env, napi_is_array(env, value, &is_array), "napi_is_array failed");
  if (!is_array) {
    throw std::runtime_error("items must be an array");
  }

  uint32_t length = 0;
  Check(env, napi_get_array_length(env, value, &length), "napi_get_array_length failed");
  if (length == 0) {
    throw std::runtime_error("items cannot be empty");
  }

  std::vector<ClipboardItem> items;
  items.reserve(length);
  for (uint32_t index = 0; index < length; ++index) {
    napi_value item;
    Check(env, napi_get_element(env, value, index, &item), "napi_get_element failed");

    napi_value type_value;
    Check(env, napi_get_named_property(env, item, "type", &type_value), "missing item.type");
    napi_value data_value;
    Check(env, napi_get_named_property(env, item, "data", &data_value), "missing item.data");

    ClipboardItem parsed;
    parsed.type_utf8 = GetString(env, type_value, "type");
    if (parsed.type_utf8.empty()) {
      throw std::runtime_error("item.type cannot be empty");
    }
    parsed.data = GetByteData(env, data_value);
#ifdef _WIN32
    parsed.type_wide = Utf8ToWide(parsed.type_utf8);
#endif
    items.push_back(std::move(parsed));
  }
  return items;
}

napi_value WriteCustomFormats(napi_env env, napi_callback_info info) {
  try {
    size_t argc = 1;
    napi_value argv[1];
    Check(env, napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr), "napi_get_cb_info failed");
    if (argc < 1) {
      throw std::runtime_error("writeCustomFormats requires an items array");
    }

    const std::vector<ClipboardItem> items = ParseItems(env, argv[0]);

#ifdef _WIN32
    WriteCustomFormatsToClipboard(items);
#else
    throw std::runtime_error("writeCustomFormats is only implemented on Windows");
#endif

    napi_value result;
    Check(env, napi_create_object(env, &result), "napi_create_object failed");

    napi_value written_types;
    Check(env, napi_create_array_with_length(env, items.size(), &written_types), "napi_create_array_with_length failed");
    for (size_t index = 0; index < items.size(); ++index) {
      napi_value type;
      Check(env, napi_create_string_utf8(env, items[index].type_utf8.c_str(), items[index].type_utf8.size(), &type), "napi_create_string_utf8 failed");
      Check(env, napi_set_element(env, written_types, static_cast<uint32_t>(index), type), "napi_set_element failed");
    }
    Check(env, napi_set_named_property(env, result, "writtenTypes", written_types), "napi_set_named_property failed");
    return result;
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"writeCustomFormats", nullptr, WriteCustomFormats, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  Check(env, napi_define_properties(env, exports, 1, properties), "napi_define_properties failed");
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
