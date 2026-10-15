/**
 * @file    bh1750.h
 * @brief   Thư viện điều khiển cảm biến cường độ ánh sáng BH1750FVI cho STM32 HAL.
 * @details Ví dụ cấu hình hướng tới STM32F103C8T6; thư viện nhận I2C handle nên có thể
 *          dùng với I2C peripheral khác khi HAL và DMA được cấu hình phù hợp.
 */

#ifndef INC_BH1750_H_
#define INC_BH1750_H_

#ifdef __cplusplus
extern "C" {
#endif

#include "stm32f1xx_hal.h"
#include <stdint.h>

/* ==========================================================================
 * 1. ĐỊA CHỈ I2C CỦA CẢM BIẾN BH1750
 * (STM32 HAL yêu cầu địa chỉ 7-bit dịch trái 1 bit: Addr << 1)
 * ========================================================================== */
#define BH1750_ADDR_GND         (0x23U << 1)  /**< Chân ADDR nối GND: 7-bit = 0x23, HAL format = 0x46 */
#define BH1750_ADDR_VCC         (0x5CU << 1)  /**< Chân ADDR nối VCC (3.3V):       7-bit = 0x5C, 8-bit = 0xB8 */

#define BH1750_DEFAULT_ADDR     BH1750_ADDR_GND

/* ==========================================================================
 * 2. TẬP LỆNH ĐIỀU KHIỂN NGUỒN (OPCODES)
 * ========================================================================== */
#define BH1750_CMD_POWER_DOWN   0x00U  /**< Trạng thái ngủ (tiêu thụ ~0.01 uA) */
#define BH1750_CMD_POWER_ON     0x01U  /**< Bật nguồn chờ lệnh đo */
#define BH1750_CMD_RESET        0x07U  /**< Xóa thanh ghi dữ liệu (chỉ hoạt động khi đang Power On) */

/* Thời gian chờ truyền lệnh cấu hình cơ bản (ms) */
#define BH1750_I2C_TIMEOUT_MS   100U

/* Hệ số quy đổi mặc định theo Datasheet ROHM BH1750FVI */
#define BH1750_CONV_FACTOR      1.2f

/* ==========================================================================
 * 3. CÁC CHẾ ĐỘ ĐO (CONTINUOUS VS ONE-TIME)
 * ========================================================================== */
typedef enum {
    /* --- CHẾ ĐỘ ĐO LIÊN TỤC (CONTINUOUS MODE) ---
     * Cảm biến tự động đo lặp đi lặp lại liên tục sau khi gửi lệnh 1 lần duy nhất.
     * Phù hợp nhất khi kết hợp với I2C DMA định kỳ trên STM32.
     */
    BH1750_MODE_CONT_HIGH_RES   = 0x10U, /**< Độ phân giải 1.0 lx, thời gian đo ~120ms (tối đa 180ms) - KHUYÊN DÙNG */
    BH1750_MODE_CONT_HIGH_RES2  = 0x11U, /**< Độ phân giải 0.5 lx, thời gian đo ~120ms (tối đa 180ms) */
    BH1750_MODE_CONT_LOW_RES    = 0x13U, /**< Độ phân giải 4.0 lx, thời gian đo ~16ms  (tối đa 24ms)  */

    /* --- CHẾ ĐỘ ĐO MỘT LẦN (ONE-TIME MODE) ---
     * Cảm biến chỉ đo đúng 1 lần sau khi nhận lệnh, sau đó tự động về Power Down (ngủ).
     * Tiết kiệm pin nhưng trước mỗi lần đọc đều phải gửi lại lệnh kích hoạt đo và đợi đo xong.
     */
    BH1750_MODE_ONETIME_HIGH_RES  = 0x20U, /**< Đo 1 lần, độ phân giải 1.0 lx, thời gian đo ~120ms */
    BH1750_MODE_ONETIME_HIGH_RES2 = 0x21U, /**< Đo 1 lần, độ phân giải 0.5 lx, thời gian đo ~120ms */
    BH1750_MODE_ONETIME_LOW_RES   = 0x23U  /**< Đo 1 lần, độ phân giải 4.0 lx, thời gian đo ~16ms  */
} BH1750_Mode_t;

/* ==========================================================================
 * 4. CẤU TRÚC QUẢN LÝ ĐỐI TƯỢNG BH1750 (HỖ TRỢ DMA AN TOÀN BỘ NHỚ)
 * ========================================================================== */
typedef struct {
    I2C_HandleTypeDef *hi2c;        /**< Con trỏ tới bộ I2C HAL (ví dụ: &hi2c1) */
    uint16_t           dev_addr;    /**< Địa chỉ I2C 8-bit (mặc định BH1750_ADDR_GND = 0x46) */
    BH1750_Mode_t      mode;        /**< Chế độ đo hiện tại */

    uint8_t            tx_cmd;      /**< Bộ đệm lệnh 1 byte tĩnh cho TX DMA */
    uint8_t            rx_buf[2];   /**< Bộ đệm nhận 2 byte (MSB, LSB) cho RX DMA */

    volatile uint8_t   dma_rx_busy; /**< Cờ báo quá trình nhận I2C DMA đang diễn ra (1: bận, 0: rảnh) */
    volatile uint8_t   dma_tx_busy; /**< Cờ báo truyền lệnh I2C DMA đang diễn ra */
    volatile uint8_t   data_ready;  /**< Cờ báo đã có kết quả Lux mới sau khi ngắt DMA hoàn tất */
    volatile uint16_t  raw_data;    /**< Giá trị số nguyên 16-bit thô ghép từ 2 byte I2C */
    volatile float     lux;         /**< Cường độ ánh sáng đã quy đổi sang đơn vị Lux (lx) */
    volatile uint8_t   conversion_pending; /**< Có phép đo chưa được đọc (kể cả lần đo đầu tiên) */
    volatile uint8_t   measurement_tx_pending; /**< Lệnh đo One-Time đang được truyền DMA */
    volatile uint32_t  conversion_start_tick; /**< Tick bắt đầu phép đo, dùng HAL_GetTick() */
} BH1750_HandleTypeDef;

/* ==========================================================================
 * 5. NGUYÊN MẪU HÀM (PUBLIC APIs)
 * ========================================================================== */

/**
 * @brief  Khởi tạo cảm biến BH1750 (bật nguồn, chờ ổn định, reset và cài đặt mode).
 * @note   Hàm dùng HAL_Delay(10 ms); cần HAL tick hoạt động. Phép đo đầu tiên bắt đầu
 *         trong lúc khởi tạo, nhưng chỉ đọc được sau thời gian chuyển đổi tối đa.
 * @param  hbh      Con trỏ tới cấu trúc quản lý BH1750
 * @param  hi2c     Con trỏ tới I2C Handle (ví dụ: &hi2c1)
 * @param  dev_addr Địa chỉ I2C (dùng BH1750_ADDR_GND hoặc BH1750_ADDR_VCC)
 * @param  mode     Chế độ đo (ví dụ: BH1750_MODE_CONT_HIGH_RES)
 * @retval HAL_StatusTypeDef (HAL_OK nếu thành công)
 */
HAL_StatusTypeDef BH1750_Init(BH1750_HandleTypeDef *hbh,
                              I2C_HandleTypeDef *hi2c,
                              uint16_t dev_addr,
                              BH1750_Mode_t mode);

/**
 * @brief  Gửi 1 byte lệnh tới BH1750 (Polling - dùng khi khởi tạo/cấu hình)
 * @param  hbh  Con trỏ tới cấu trúc quản lý BH1750
 * @param  cmd  Mã lệnh (Opcode)
 * @retval HAL_StatusTypeDef
 */
HAL_StatusTypeDef BH1750_SendCommand(BH1750_HandleTypeDef *hbh, uint8_t cmd);

/**
 * @brief  Gửi 1 byte lệnh tới BH1750 bằng DMA (non-blocking).
 * @note   Yêu cầu cấu hình TX DMA, I2C event/error interrupt và gọi
 *         BH1750_DMA_TxCpltHandler() trong HAL_I2C_MasterTxCpltCallback().
 *         Nếu cmd là một mode đo hợp lệ, trạng thái phép đo được cập nhật.
 * @param  hbh  Con trỏ tới cấu trúc quản lý BH1750
 * @param  cmd  Mã lệnh (Opcode)
 * @retval HAL_StatusTypeDef
 */
HAL_StatusTypeDef BH1750_SendCommand_DMA(BH1750_HandleTypeDef *hbh, uint8_t cmd);

/**
 * @brief  Trả về thời gian đo tối đa theo datasheet (ms); 0 nếu mode không hợp lệ.
 */
uint16_t BH1750_GetMeasurementTimeMs(BH1750_Mode_t mode);

/**
 * @brief  Thay đổi chế độ đo của BH1750
 * @note   Gửi lệnh dạng polling; mode mới bắt đầu một phép đo ngay khi gửi thành công.
 * @param  hbh   Con trỏ tới cấu trúc quản lý BH1750
 * @param  mode  Chế độ đo mới
 * @retval HAL_StatusTypeDef
 */
HAL_StatusTypeDef BH1750_SetMode(BH1750_HandleTypeDef *hbh, BH1750_Mode_t mode);

/**
 * @brief  Bắt đầu một phép đo mới trong chế độ One-Time (không chặn, dùng DMA).
 * @retval HAL_BUSY nếu phép đo trước chưa được đọc hoặc I2C đang bận.
 */
HAL_StatusTypeDef BH1750_StartMeasurement_DMA(BH1750_HandleTypeDef *hbh);

/**
 * @brief  Kiểm tra phép đo đang chờ đã hoàn tất chuyển đổi hay chưa.
 */
uint8_t BH1750_IsMeasurementReady(BH1750_HandleTypeDef *hbh);

/**
 * @brief  Kích hoạt đọc 2 byte dữ liệu ánh sáng qua I2C DMA (Không gây trễ CPU)
 * @note   Yêu cầu cấu hình RX DMA, I2C event/error interrupt và gọi
 *         BH1750_DMA_RxCpltHandler() trong HAL_I2C_MasterRxCpltCallback().
 *         Với One-Time, gọi BH1750_StartMeasurement_DMA() trước mỗi lần đọc.
 * @param  hbh  Con trỏ tới cấu trúc quản lý BH1750
 * @retval HAL_StatusTypeDef (HAL_OK nếu bắt đầu DMA thành công, HAL_BUSY nếu đang bận)
 */
HAL_StatusTypeDef BH1750_StartRead_DMA(BH1750_HandleTypeDef *hbh);

/**
 * @brief  Hàm xử lý hoàn tất nhận DMA (Gọi hàm này bên trong HAL_I2C_MasterRxCpltCallback)
 * @param  hbh   Con trỏ tới cấu trúc quản lý BH1750
 * @param  hi2c  Con trỏ I2C được truyền vào từ callback của HAL
 */
void BH1750_DMA_RxCpltHandler(BH1750_HandleTypeDef *hbh, I2C_HandleTypeDef *hi2c);

/**
 * @brief  Giải phóng trạng thái TX DMA (gọi từ HAL_I2C_MasterTxCpltCallback).
 */
void BH1750_DMA_TxCpltHandler(BH1750_HandleTypeDef *hbh, I2C_HandleTypeDef *hi2c);

/**
 * @brief  Xử lý lỗi I2C/DMA để giải phóng cờ bận (gọi trong HAL_I2C_ErrorCallback).
 * @param  hbh   Con trỏ tới cấu trúc quản lý BH1750
 * @param  hi2c  Con trỏ I2C được truyền vào từ callback của HAL
 */
void BH1750_DMA_ErrorHandler(BH1750_HandleTypeDef *hbh, I2C_HandleTypeDef *hi2c);

/**
 * @brief  Kiểm tra xem dữ liệu Lux mới từ DMA đã sẵn sàng chưa
 * @param  hbh  Con trỏ tới cấu trúc quản lý BH1750
 * @retval 1 nếu có dữ liệu mới, 0 nếu chưa có
 */
uint8_t BH1750_IsDataReady(BH1750_HandleTypeDef *hbh);

/**
 * @brief  Lấy giá trị cường độ sáng (Lux) mới nhất và xóa cờ data_ready.
 * @note   Gọi sau khi BH1750_IsDataReady() trả về khác 0.
 * @param  hbh  Con trỏ tới cấu trúc quản lý BH1750
 * @retval Cường độ sáng tính bằng Lux (float)
 */
float BH1750_GetLux(BH1750_HandleTypeDef *hbh);

#ifdef __cplusplus
}
#endif

#endif /* INC_BH1750_H_ */