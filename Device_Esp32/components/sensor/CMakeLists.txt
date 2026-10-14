idf_component_register(
    SRCS "src/confi.c"
         "src/sr522.c"
        "src/zh_bh1750.c"
        "src/DHT22.c"
    INCLUDE_DIRS "include"
    REQUIRES esp_driver_gpio esp_driver_i2c esp_driver_ledc
)