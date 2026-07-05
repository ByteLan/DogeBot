{
  "targets": [
    {
      "target_name": "doge_clipboard_native",
      "sources": ["src/win_clipboard.cc"],
      "defines": ["NAPI_VERSION=8", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
      "conditions": [
        ["OS=='win'", {
          "libraries": ["user32.lib"]
        }]
      ],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "ExceptionHandling": 1,
          "AdditionalOptions": ["/utf-8"]
        }
      },
      "xcode_settings": {
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
      }
    }
  ]
}
