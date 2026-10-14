idf_component_register(
    SRCS "src/my_mqtt.c"
    INCLUDE_DIRS "include"
    REQUIRES sensor mqtt json
)